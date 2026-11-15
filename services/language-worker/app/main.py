from fastapi import FastAPI, HTTPException

from .models import LanguageReviewRequest, LanguageReviewResult
from .reviewer import OpenAICompatibleReviewer


app = FastAPI(title="InkRelay Language Worker", version="0.1.0")
reviewer = OpenAICompatibleReviewer()


@app.get("/health")
async def health() -> dict[str, object]:
    return await reviewer.health()


@app.post("/v1/language/review", response_model=LanguageReviewResult)
async def review(request: LanguageReviewRequest) -> LanguageReviewResult:
    try:
        return await reviewer.review(request)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
