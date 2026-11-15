import json

import pytest

from PIL import Image

from app.models import LanguageReviewRequest
from app.render import render_page_png
from app.reviewer import (
    OpenAICompatibleReviewer,
    _available_model_ids,
    _completion_content,
    _parse_json_object,
    _system_prompt,
)


def sample_request() -> LanguageReviewRequest:
    return LanguageReviewRequest.model_validate(
        {
            "schemaVersion": "inkrelay.language_worker_request.v1",
            "reviewId": "review_test",
            "options": {"language": "English", "explanationLanguage": "English"},
            "page": {
                "notebookId": "NB01",
                "pageId": 12,
                "width": 1480,
                "height": 2100,
                "updatedAtMs": 2000,
                "strokes": [
                    {
                        "strokeId": "s1",
                        "semanticRole": "ink",
                        "style": {"color": "#111111", "width": 2, "opacity": 1},
                        "points": [{"x": 100, "y": 200}, {"x": 300, "y": 210}],
                    }
                ],
            },
        }
    )


def test_page_renderer_crops_and_renders_visible_ink(tmp_path):
    output = render_page_png(sample_request().page)
    image_path = tmp_path / "page.png"
    image_path.write_bytes(output)
    with Image.open(image_path) as image:
        assert image.format == "PNG"
        assert max(image.size) <= 1600
        assert image.getbbox() is not None
        assert image.getpixel((image.width // 2, image.height // 2)) != (255, 255, 255)


def test_model_json_parser_accepts_plain_and_fenced_objects():
    expected = {"detected_language": "English", "original_text": "I go.", "corrected_text": "I went."}
    encoded = json.dumps(expected)
    assert _parse_json_object(encoded) == expected
    assert _parse_json_object(f"```json\n{encoded}\n```") == expected
    assert _completion_content({"choices": [{"message": {"content": encoded}}]}) == encoded


def test_prompt_requires_transcription_fidelity_and_examples():
    prompt = _system_prompt("French")
    assert "[unclear]" in prompt
    assert "Do not silently correct or normalize" in prompt
    assert "preserving the writer's intended meaning" in prompt
    assert "literal translation" in prompt
    assert "false friends" in prompt
    assert "cultural usage" in prompt
    assert "look or sound similar" in prompt
    assert 'begin the explanation with "Did you mean ...?"' in prompt
    assert "Do not stereotype cultures" in prompt
    assert 'Address the writer directly as "you"' in prompt
    assert '"the student"' in prompt
    assert "examples" in prompt
    assert "French" in prompt


def test_available_model_ids_treats_null_data_as_empty():
    assert _available_model_ids({"object": "list", "data": None}) == set()
    assert _available_model_ids(
        {"data": [{"id": "gemma3:4b"}, {"id": 42}, None]}
    ) == {"gemma3:4b"}


def test_worker_configuration_comes_from_environment(monkeypatch):
    monkeypatch.setenv("INKRELAY_OPENAI_BASE_URL", "https://cloud.example/v1/")
    monkeypatch.setenv("INKRELAY_OPENAI_API_KEY", "secret")
    monkeypatch.setenv("INKRELAY_LANGUAGE_MODEL", "vision-model")
    monkeypatch.setenv("INKRELAY_MODEL_PROVIDER", "cloud-compatible")
    monkeypatch.setenv("INKRELAY_MODEL_TIMEOUT_SECONDS", "42")
    monkeypatch.setenv("INKRELAY_IMAGE_URL_FORMAT", "object")
    monkeypatch.setenv("INKRELAY_MODEL_HEALTHCHECK", "disabled")
    monkeypatch.setenv("INKRELAY_RESPONSE_FORMAT", "none")
    reviewer = OpenAICompatibleReviewer()
    assert reviewer.base_url == "https://cloud.example/v1"
    assert reviewer.api_key == "secret"
    assert reviewer.model == "vision-model"
    assert reviewer.provider == "cloud-compatible"
    assert reviewer.timeout_seconds == 42
    assert reviewer.image_url_format == "object"
    assert reviewer.healthcheck == "disabled"
    assert reviewer.response_format == "none"
    assert reviewer._headers() == {"Authorization": "Bearer secret"}


def test_worker_refuses_to_select_an_implicit_model(monkeypatch):
    for name in (
        "INKRELAY_OPENAI_BASE_URL",
        "INKRELAY_LANGUAGE_MODEL",
        "INKRELAY_MODEL_PROVIDER",
    ):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(ValueError, match="INKRELAY_OPENAI_BASE_URL is required"):
        OpenAICompatibleReviewer()
