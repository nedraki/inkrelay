"""Minimal InkRelay-compatible Python workflow worker.

Run with uv:
    uv run uvicorn app:app --host 127.0.0.1 --port 8321
"""

from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict


class WorkflowIntent(BaseModel):
    model_config = ConfigDict(extra="allow")
    intentId: str
    kind: str
    notebookId: str
    pageId: int


class WorkflowRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    schemaVersion: str
    intent: WorkflowIntent
    page: dict[str, Any]


class WorkflowResult(BaseModel):
    markdown: str
    metadata: dict[str, Any]


app = FastAPI(title="InkRelay Python Worker")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/workflows/execute", response_model=WorkflowResult)
def execute(request: WorkflowRequest) -> WorkflowResult:
    # Replace this deterministic placeholder with your OCR/AI pipeline.
    return WorkflowResult(
        markdown=f"## Python result\n\nProcessed {request.intent.notebookId}, page {request.intent.pageId}.",
        metadata={
            "processor": "example-python-worker",
            "processorVersion": "0.1.0",
            "intentKind": request.intent.kind,
        },
    )
