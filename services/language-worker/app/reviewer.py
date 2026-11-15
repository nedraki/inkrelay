import base64
import json
import os
from typing import Any

import httpx

from .models import LanguageReviewRequest, LanguageReviewResult, ModelReview, Provenance
from .render import render_page_png


PIPELINE_VERSION = "inkrelay-language-vision-v2"


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise ValueError(
            f"{name} is required; copy one config/language/*.env.example profile to .env.language"
        )
    return value


def _available_model_ids(payload: dict[str, Any]) -> set[str]:
    data = payload.get("data")
    if not isinstance(data, list):
        return set()
    return {
        model_id
        for item in data
        if isinstance(item, dict)
        and isinstance(model_id := item.get("id"), str)
    }


class OpenAICompatibleReviewer:
    def __init__(self) -> None:
        self.base_url = _required_env("INKRELAY_OPENAI_BASE_URL").rstrip("/")
        self.api_key = os.getenv("INKRELAY_OPENAI_API_KEY", "")
        self.model = _required_env("INKRELAY_LANGUAGE_MODEL")
        self.provider = _required_env("INKRELAY_MODEL_PROVIDER")
        self.timeout_seconds = float(os.getenv("INKRELAY_MODEL_TIMEOUT_SECONDS", "3600"))
        self.image_url_format = os.getenv("INKRELAY_IMAGE_URL_FORMAT", "string")
        self.healthcheck = os.getenv("INKRELAY_MODEL_HEALTHCHECK", "models")
        self.response_format = os.getenv("INKRELAY_RESPONSE_FORMAT", "json_object")
        if self.image_url_format not in {"string", "object"}:
            raise ValueError("INKRELAY_IMAGE_URL_FORMAT must be string or object")
        if self.healthcheck not in {"models", "disabled"}:
            raise ValueError("INKRELAY_MODEL_HEALTHCHECK must be models or disabled")
        if self.response_format not in {"json_object", "none"}:
            raise ValueError("INKRELAY_RESPONSE_FORMAT must be json_object or none")

    def _headers(self, *, json_content: bool = False) -> dict[str, str]:
        headers = {"Content-Type": "application/json"} if json_content else {}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _identity(self) -> dict[str, str]:
        return {
            "model": self.model,
            "provider": self.provider,
            "pipelineVersion": PIPELINE_VERSION,
            "modelEndpoint": self.base_url,
        }

    async def health(self) -> dict[str, Any]:
        if self.healthcheck == "disabled":
            return {"status": "ok", **self._identity(), "healthcheck": "disabled"}
        try:
            async with httpx.AsyncClient(timeout=min(5.0, self.timeout_seconds)) as client:
                response = await client.get(
                    f"{self.base_url}/models",
                    headers=self._headers(),
                )
                response.raise_for_status()
                available = _available_model_ids(response.json())
            if self.model not in available:
                return {
                    "status": "model_missing",
                    **self._identity(),
                    "error": f"Model {self.model} is not installed at the configured endpoint",
                }
            return {
                "status": "ok",
                **self._identity(),
                "healthcheck": "models",
            }
        except (httpx.HTTPError, ValueError) as error:
            return {
                "status": "model_unavailable",
                **self._identity(),
                "error": str(error),
            }

    async def review(self, request: LanguageReviewRequest) -> LanguageReviewResult:
        png = render_page_png(request.page)
        image_url = f"data:image/png;base64,{base64.b64encode(png).decode('ascii')}"
        image_value: str | dict[str, str]
        if self.image_url_format == "object":
            image_value = {"url": image_url}
        else:
            image_value = image_url
        payload = {
            "model": self.model,
            "temperature": 0.1,
            "messages": [
                {
                    "role": "system",
                    "content": _system_prompt(request.options.explanationLanguage),
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": _user_prompt(request.options.language),
                        },
                        {"type": "image_url", "image_url": image_value},
                    ],
                },
            ],
        }
        if self.response_format == "json_object":
            payload["response_format"] = {"type": "json_object"}
        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.post(
                    f"{self.base_url}/chat/completions",
                    headers=self._headers(json_content=True),
                    json=payload,
                )
                response.raise_for_status()
        except httpx.HTTPError as error:
            raise RuntimeError(f"OpenAI-compatible model request failed: {error}") from error

        content = _completion_content(response.json())
        model_review = ModelReview.model_validate(_parse_json_object(content))
        return LanguageReviewResult(
            detectedLanguage=model_review.detected_language,
            originalText=model_review.original_text,
            correctedText=model_review.corrected_text,
            summary=model_review.summary,
            corrections=model_review.corrections,
            strengths=model_review.strengths,
            nextSteps=model_review.next_steps,
            provenance=Provenance(
                provider=self.provider,
                model=self.model,
                pipelineVersion=PIPELINE_VERSION,
                inputMode="page_image",
            ),
        )


def _system_prompt(explanation_language: str) -> str:
    return f"""You are a careful language teacher reviewing a short handwritten essay.
First make original_text a faithful transcription of only what is visible. Do not silently correct or normalize it. Never invent missing words; write [unclear] where text cannot be read.
Then produce corrected_text and corrections. Correct grammar, spelling, agreement, word order, punctuation, and vocabulary while preserving the writer's intended meaning and voice.
The writer is learning a language. Evaluate each word or expression in its full sentence and essay context, not only in isolation. Look for literal translation, false friends, inappropriate register, non-idiomatic phrasing, cultural usage, and words chosen because they look or sound similar to the intended word.
When a word does not fit its context, suggest the natural word or expression and explain the relevant difference in meaning, register, idiom, pronunciation, or cultural use. Do not stereotype cultures or present one regional variety as the only valid form.
When the intended meaning is genuinely ambiguous, do not claim certainty. Choose the most likely contextual replacement, begin the explanation with "Did you mean ...?", and briefly mention another plausible reading when useful. Keep [unclear] instead of guessing when the handwriting itself cannot be read.
Do not rewrite merely for style. Put explanations, the summary, strengths, and next steps in {explanation_language}.
Address the writer directly as "you" with a warm, specific teaching voice; do not refer to them impersonally as "the student".
Return one JSON object only, using exactly this shape:
{{
  "detected_language": "language name",
  "original_text": "faithful transcription",
  "corrected_text": "complete corrected essay",
  "summary": "brief teacher overview",
  "corrections": [
    {{
      "original": "exact original word or phrase",
      "replacement": "corrected word or phrase; empty only for deletion",
      "category": "specific learning category such as grammar, spelling, vocabulary, false friend, phonetic confusion, idiom, register, or cultural usage",
      "explanation": "clear reason for this correction",
      "examples": [{{"incorrect": "example", "correct": "corrected example"}}]
    }}
  ],
  "strengths": ["specific strength"],
  "next_steps": ["specific practice suggestion"]
}}
List corrections in essay order. Include one or two short examples per correction when useful."""


def _user_prompt(language: str) -> str:
    if language.casefold() in {"auto", "auto-detect", "automatic"}:
        return "Detect the language of the handwritten essay, transcribe it, and review it according to the system instructions."
    return f"The handwritten essay is expected to be in {language}. Transcribe and review it according to the system instructions."


def _completion_content(payload: dict[str, Any]) -> str:
    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as error:
        raise ValueError("Model response did not contain choices[0].message.content") from error
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        text = "".join(part.get("text", "") for part in content if isinstance(part, dict))
        if text:
            return text
    raise ValueError("Model response content was not text")


def _parse_json_object(content: str) -> dict[str, Any]:
    text = content.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        text = "\n".join(lines[1:-1] if lines[-1].strip().startswith("```") else lines[1:])
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("Model did not return a JSON object") from None
        value = json.loads(text[start : end + 1])
    if not isinstance(value, dict):
        raise ValueError("Model returned JSON that was not an object")
    return value
