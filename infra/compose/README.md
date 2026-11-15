# Language-teacher containers

Run these commands **from the repository root**. `--project-directory .` keeps build paths, the private `.env.language` file and the Compose project identity rooted there, as they were before these files moved.

| File | Purpose |
| --- | --- |
| `language.yml` | Base Ollama model and Python review worker |
| `language.nvidia.yml` | NVIDIA GPU override |
| `language.amd.yml` | AMD ROCm override |
| `language.forwarded.yml` | Worker host networking for a loopback-forwarded model endpoint |

For the local CPU setup:

```bash
docker compose --project-directory . -f infra/compose/language.yml up -d language-model
```

For NVIDIA, add the override after the base file:

```bash
docker compose --project-directory . -f infra/compose/language.yml -f infra/compose/language.nvidia.yml up -d language-model
```

AMD and forwarded configurations use the same pattern with their respective override. The forwarded endpoint needs its own model profile; do not combine its host networking with the bundled Ollama service hostname. See the [full setup guide](../../docs/language-teacher.md) before starting services or submitting pages.

Environment templates stay in `config/language/`; the selected private `.env.language` stays at the repository root. The worker Dockerfile and build context stay in `services/language-worker/`, beside the code they package. Model weights stay in the existing named Docker volume `inkrelay_ollama_models`.

## Updating an existing installation

Replace the old root-level `-f docker-compose.language…yml` paths with the corresponding `infra/compose/language…yml` paths, and include `--project-directory .`. Keep using the same repository folder and any explicit project name (`-p`) you previously chose. No environment, notes, container or model-volume migration is required for this file move. Do not delete or recreate volumes as part of the update.

To validate configuration without starting containers or reading service credentials:

```bash
docker compose --project-directory . -f infra/compose/language.yml config --no-env-resolution --quiet
```
