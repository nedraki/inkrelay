# Contributing to InkRelay

Start with [AGENTS.md](AGENTS.md) for layer ownership, data-preservation contracts and required checks. Keep source ink canonical, imports non-destructive and uncertain recognition faithful.

Use synthetic fixtures and fake pen identities. Never commit real writing, vaults, environment files, notebook assignments, pen identifiers or screenshots from a user's session. Include the smallest relevant documentation update and tests for behavior/replay changes.

Before handing off code, run `pnpm test`, `pnpm typecheck`, `pnpm build` and, for the worker checks, `uv run pytest` from `services/language-worker`. Python projects use `uv` and committed locks. Hardware acceptance is separate from automated tests.

Run `pnpm publication:check` before preparing shared source. Preserve `LICENSE`, `NOTICE` and third-party notices; discuss a dependency's terms or uncertain vendor-code provenance before incorporating it. Contributors should choose a public commit identity they are comfortable publishing.
