# Python worker example

This optional service demonstrates InkRelay's versioned localhost HTTP boundary. It is not required for capture, reconstruction, Excalidraw, or Obsidian export. The server currently queues workflow intents but does not dispatch them automatically.

From this directory:

```bash
uv sync
uv run uvicorn app:app --host 127.0.0.1 --port 8321
```

Check it with `curl http://127.0.0.1:8321/health`.

Replace the body of `execute` with OCR or AI code. Python returns structured content and provenance; the TypeScript backend remains responsible for job identity, retries, status, validation, and vault writes. Do not make this worker edit the Obsidian vault directly.

The implemented contract is:

- `GET /health`
- `POST /v1/workflows/execute`
- request schema `inkrelay.python_request.v1`
- response `{ "markdown": "...", "metadata": { ... } }`

Automatic execution, retry, result persistence, and user review remain roadmap work.
