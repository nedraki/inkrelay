# InkRelay agent guide

This repository implements a local-first smartpen capture and projection system. Before changing behavior, read:

1. `README.md`
2. `docs/architecture.md`
3. `docs/design-contracts.md`
4. `docs/development.md`
5. `docs/neo-linux-hardware.md` for device or paper work
6. `docs/language-teacher.md` for Python/model or grammar-review work
7. `docs/roadmap.md` for intended direction
8. `docs/ui-design.md` for interface hierarchy and visual direction

## Non-negotiable rules

- Validated normalized events are appended before they are interpreted.
- The append-only event corpus is canonical; strokes, actions, SVG, Excalidraw, Obsidian, OCR, and AI are projections.
- Preserve idempotency using event identity `(penId, sessionId, sequence)`.
- Offline Neo transfers retain data and are acknowledged only after durable ingestion.
- Do not claim Neo-app compatibility for live-session data; use offline import for the dual-consumer path.
- TypeScript owns orchestration and vault writes. Python workers return versioned structured results with provenance.
- Python environments and dependency locks use `uv`; the local model runs in Docker with weights in a named volume.
- Recognition falls back to faithful ink when uncertain.
- Keep the server loopback-only by default.
- Treat browser Excalidraw edits as a best-effort cache until server scene persistence exists.
- Do not change schemas, identity, coordinate meaning, storage locations, or renderer IDs without a documented migration.

## Work in the right layer

- Domain contracts and reconstruction: `packages/core`
- Vendor/transport parsing: `packages/adapters`
- Paper commands: `packages/action-router` and `config/action-zones.json`
- Deterministic projections: `packages/render-svg`, `packages/render-excalidraw`
- Canonical storage and vault export: `packages/obsidian-writer`
- Durable workflow contracts: `packages/workflows`
- Local vision inference only: `services/language-worker`
- Orchestration/API only: `apps/server`
- Presentation and browser scene cache: `apps/web`

Do not leak Neo packet details into core or UI. Do not make the browser the only owner of captured input. Do not let a Python process write vault files.

For Python changes, update `pyproject.toml` through `uv`, commit `uv.lock`, and run `uv run pytest`. Do not add pip/requirements, Poetry, or Conda workflows. Keep model-provider calls behind the OpenAI-compatible worker boundary.

## Validation

Run before handoff:

```bash
pnpm test
pnpm typecheck
pnpm build
cd services/language-worker && uv run pytest
```

Add deterministic fixtures/tests for protocol packets, replay, deduplication, recognition thresholds, or persistence behavior as appropriate. Automated tests must not require Bluetooth hardware or a live model.

For hardware changes, document a manual path covering connect, live writing, disconnect, offline writing, non-destructive import, repeat import, page switch, and controller actions. Preserve user data and never add firmware or pen-memory deletion commands as a side effect.

## Documentation responsibility

Update the smallest relevant document in the same change. Keep `README.md` focused on users and the current truth; put subsystem details in `docs/architecture.md`, invariants in `docs/design-contracts.md`, commands in `docs/development.md`, hardware observations in `docs/neo-linux-hardware.md`, language-model operation in `docs/language-teacher.md`, and unimplemented direction in `docs/roadmap.md`.
