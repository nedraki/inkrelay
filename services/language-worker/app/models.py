from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Point(BaseModel):
    model_config = ConfigDict(extra="ignore")
    x: float
    y: float


class StrokeStyle(BaseModel):
    model_config = ConfigDict(extra="ignore")
    color: str = "#111111"
    width: float = 2
    opacity: float = 1


class Stroke(BaseModel):
    model_config = ConfigDict(extra="ignore")
    strokeId: str
    semanticRole: Literal["ink", "action", "ink_and_action"]
    style: StrokeStyle
    points: list[Point]


class Page(BaseModel):
    model_config = ConfigDict(extra="ignore")
    notebookId: str
    pageId: int
    width: float
    height: float
    updatedAtMs: int
    strokes: list[Stroke]


class ReviewOptions(BaseModel):
    language: str = Field(min_length=1, max_length=80)
    explanationLanguage: str = Field(min_length=1, max_length=80)


class LanguageReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schemaVersion: Literal["inkrelay.language_worker_request.v1"]
    reviewId: str
    page: Page
    options: ReviewOptions


class CorrectionExample(BaseModel):
    model_config = ConfigDict(extra="ignore")
    incorrect: str
    correct: str


class ModelCorrection(BaseModel):
    model_config = ConfigDict(extra="ignore")
    original: str
    replacement: str
    category: str = Field(min_length=1)
    explanation: str = Field(min_length=1)
    examples: list[CorrectionExample] = Field(default_factory=list, max_length=4)


class ModelReview(BaseModel):
    model_config = ConfigDict(extra="ignore")
    detected_language: str = Field(min_length=1)
    original_text: str = Field(min_length=1)
    corrected_text: str = Field(min_length=1)
    summary: str = ""
    corrections: list[ModelCorrection] = Field(default_factory=list, max_length=100)
    strengths: list[str] = Field(default_factory=list, max_length=20)
    next_steps: list[str] = Field(default_factory=list, max_length=20)


class Provenance(BaseModel):
    provider: str
    model: str
    pipelineVersion: str
    inputMode: Literal["page_image"] = "page_image"


class LanguageReviewResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schemaVersion: Literal["inkrelay.language_worker_result.v1"] = "inkrelay.language_worker_result.v1"
    detectedLanguage: str
    originalText: str
    correctedText: str
    summary: str
    corrections: list[ModelCorrection]
    strengths: list[str]
    nextSteps: list[str]
    provenance: Provenance
