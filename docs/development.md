# Local development and operations

This guide covers a clean local setup, real-pen preparation, configuration, verification, and common failures.

## Repository layout

| Folder | Responsibility |
| --- | --- |
| `apps/` | TypeScript server and browser interface |
| `packages/` | Shared domain, adapters, storage and projection libraries |
| `services/` | Python workers and their service-specific Dockerfiles |
| `infra/compose/` | Docker Compose base configuration and hardware/network overrides |
| `config/` | Shared configuration and safe environment templates |
| `native/` | Platform-specific Bluetooth helpers |
| `tests/`, `fixtures/` | Automated tests and synthetic inputs |
| `scripts/` | Build, attribution and source-publication tooling |
| `docs/`, `skills/` | User/developer documentation and agent setup guidance |
| `licenses/` | Third-party inventories and notices |
| `tmp/` | Ignored local runtime data; persistent notes must be backed up |

Workspace manifests, package locks, TypeScript/test configuration, `.env.example` and repository-level guidance remain at the root. Active `.env` and `.env.language` files remain private there. See [container configuration](../infra/compose/README.md) for Compose commands and migration from the old root-level files.

## Prerequisites

- Node.js 22.19 or newer
- pnpm 10; `package.json` pins `pnpm@10.10.0`
- For direct pen support: Linux with BlueZ/system D-Bus, or macOS 12+ with Xcode Command Line Tools
- `uv` and Python 3.11+ only when developing a Python worker
- Docker Compose only when running the local language model

Confirm the JavaScript tools:

```bash
node --version
pnpm --version
```

If pnpm is absent and Node was installed with Corepack:

```bash
corepack enable
corepack prepare pnpm@10.10.0 --activate
```

## First run

From the repository root:

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

If `.env` already exists, preserve it rather than running the copy command.

Development uses two processes:

| Process | Address | Role |
| --- | --- | --- |
| Fastify/tsx | `http://127.0.0.1:4317` | API, SSE, Bluetooth, storage |
| Vite | `http://127.0.0.1:4318` | Browser UI with API proxy |

Open <http://127.0.0.1:4318>. Saving TypeScript/React files reloads the relevant process.

For a built local run:

```bash
pnpm build
pnpm start
```

Open <http://127.0.0.1:4317>. Build output goes to `apps/server/dist` and `apps/web/dist`; Fastify serves the latter when present.

Check the server independently:

```bash
curl http://127.0.0.1:4317/api/health
curl http://127.0.0.1:4317/api/state
```

## Configuration

The server loads `.env` from the repository root. Shell environment variables take precedence. This file configures only the TypeScript application; it does not select the language model. Neither `pnpm dev` nor `pnpm start` writes this file.

| Variable | Default when unset | Meaning |
| --- | --- | --- |
| `OBSIDIAN_VAULT_PATH` | `tmp/demo-vault` | Vault root receiving `Smartpen/` exports |
| `INKRELAY_DATA_PATH` | `tmp/inkrelay-data/raw` | Canonical session-event directory |
| `INKRELAY_PAPER_PROFILES_PATH` | `tmp/inkrelay-data/paper-profiles.json` | Versioned local mapping from notebook identity to physical dimensions |
| `INKRELAY_NOTEBOOK_INSTANCES_PATH` | `tmp/inkrelay-data/notebook-instances.json` | Physical-copy names, active selections, durable session/sequence boundaries, and capture-range corrections |
| `INKRELAY_HOST` | `127.0.0.1` | API bind address; keep loopback unless network security is designed |
| `INKRELAY_PORT` | `4317` | API and built-UI port |
| `INKRELAY_PYTHON_SERVICE_URL` | `http://127.0.0.1:8321` | Reserved Python executor endpoint; not automatically invoked yet |
| `INKRELAY_LANGUAGE_WORKER_URL` | Python URL or `http://127.0.0.1:8321` | Implemented language-teacher worker endpoint |
| `INKRELAY_LANGUAGE_REVIEW_TIMEOUT_MS` | `3600000` | Backend-to-worker request timeout in milliseconds; use a value at least as long as the worker's model timeout |
| `INKRELAY_BLUETOOTH_ENABLED` | `true` | Set exactly `false` to disable native Bluetooth initialization |
| `INKRELAY_MACOS_BLUETOOTH_HELPER` | `native/macos/.build/InkRelayBluetooth.app/Contents/MacOS/InkRelayBluetooth` under the working directory | Optional custom Core Bluetooth helper executable |
| `SMARTPEN_DEFAULT_PAGE_WIDTH` | `1480` | Fallback page width in `app_px` for unknown paper |
| `SMARTPEN_DEFAULT_PAGE_HEIGHT` | `2100` | Fallback page height in `app_px` for unknown paper |

Relative paths resolve from the process working directory, which should be the repository root. Prefer an absolute `OBSIDIAN_VAULT_PATH` for a real vault.

The separate `.env.language` file selects the Python worker's model endpoint. Docker Compose passes it into the worker through `env_file`; it never copies it into `.env` and never writes either file. Create `.env.language` from exactly one profile under `config/language/`: bundled Ollama, forwarded vLLM, or OpenAI cloud. See [Language teacher model setup](language-teacher.md#select-one-model-profile) for the selection table and exact commands. Recreate the worker after changing profiles; restarting only `pnpm dev` does not update a running worker container.

The vault can also be changed while InkRelay is running from **Session → Obsidian vault**. The UI accepts an existing absolute folder path, applies it to subsequent exports immediately, and stores the override in `<INKRELAY_DATA_PATH>/../settings.json`. A saved UI choice takes precedence over `OBSIDIAN_VAULT_PATH` after restart. A folder without `.obsidian` is accepted but shown with a warning so a new or deliberately prepared vault remains possible.

Vault schema `inkrelay.obsidian_page.v1` uses deterministic generation directories and publishes Markdown last. Upgrading from the original flat layout is non-destructive: the next export writes the new `Smartpen/Notebooks`, nested `Attachments`, and nested `Data` paths; copies legacy marker-protected text into the new user-owned `Page_<page> Notes.md` if that file does not yet exist; and leaves every legacy file unchanged. Rollback therefore means using the retained legacy files. There is no automatic cleanup of legacy files or obsolete generations yet.

The canonical path should end in `raw`, as in the supplied `.env.example`. Workflow logs are written to its sibling `workflow`, and grammar reviews to `language-reviews`. Changing this layout after capture requires moving all three deliberately.

## Register paper dimensions

After InkRelay captures or imports at least one page, select that page and open **Session → Paper product**. The displayed `NEO_<section>_<owner>_<note>` value is the identity read from the paper. Enter a recognizable product name plus the physical page width and height in millimetres, as the page is viewed, then select **Register this paper product**. Landscape orientation is represented by entering the larger dimension as the width.

The profile applies immediately to every reconstructed page with that notebook identity and survives restarts in `INKRELAY_PAPER_PROFILES_PATH`. Unknown identities continue using `SMARTPEN_DEFAULT_PAGE_WIDTH` and `SMARTPEN_DEFAULT_PAGE_HEIGHT`. Updating a profile increments its revision; it never rewrites canonical events or stored source coordinates.

The canvas uses 10 `app_px` per millimetre, so a 148 × 210 mm page becomes a 1480 × 2100 canvas. Neo's reported coordinate units do not necessarily equal physical millimetres for every paper identity. To calibrate a product, use a page whose latest four ink strokes form two crosses: draw the top-left cross first and the bottom-right cross second, with each centre exactly 10 mm from its two adjacent edges. Select that page, open **Session → Paper product**, and choose **Calibrate from latest crosses**. The mapping is reusable for every page and physical copy with the same printed paper identity.

The catalog schema is `inkrelay.paper_catalog.v2`. InkRelay reads dimension-only v1 files as an identity-transform migration and writes v2 on the next profile update. A calibrated profile has this shape:

```json
{
  "schemaVersion": "inkrelay.paper_catalog.v2",
  "profiles": [
    {
      "notebookId": "NEO_3_27_1",
      "displayName": "My official notebook",
      "widthMm": 148,
      "heightMm": 210,
      "appPxPerMm": 10,
      "calibration": {
        "kind": "axis_aligned_affine",
        "scaleX": 2.4,
        "scaleY": 2.4,
        "offsetX": -150,
        "offsetY": -125,
        "anchors": [
          { "sourceX": 104.2, "sourceY": 95.5, "paperXMm": 10, "paperYMm": 10 },
          { "sourceX": 819.1, "sourceY": 1063.1, "paperXMm": 138, "paperYMm": 200 }
        ]
      },
      "revision": 2
    }
  ]
}
```

Calibration models independent X/Y scale and origin offset. It does not yet model rotation, skew, curved paper, spreads, page-specific transforms, or different transforms among products that reuse the same printed identity. Recalibration always uses the selected page's latest four non-action strokes and therefore should be performed immediately after drawing the two reference crosses.

## Distinguish physical notebook copies

Neo reports the printed paper identity, not a serial number for the physical object. InkRelay therefore creates a separate physical-notebook instance layer while retaining the original Neo identity in every canonical event.

Existing data migrates automatically into one default physical instance whose ID equals the existing notebook ID. This preserves existing API defaults and Obsidian folder paths. Give it a personal name in **Get my notes → Physical notebook**, for example `French course — 2026`.

Before changing to another physical notebook that uses the same paper identity:

1. Select a page from the paper identity you are about to reuse.
2. Open **Get my notes → Physical notebook**.
3. Choose an existing physical copy, or select **Start a new physical notebook** and name it.
4. Only then start writing or import the stored writing from that copy.

The next accepted event records a durable boundary containing the source paper identity, pen, session, starting sequence, and selected physical-notebook ID. Replay uses those recorded boundaries instead of the currently active selection. Pages, language reviews, browser Excalidraw caches, and Obsidian exports are partitioned by physical-notebook ID; raw events keep their original `notebookId`.

If writing was filed to the wrong physical copy, select the affected page and open **Get my notes → Physical notebook → Repair an assignment**. Choose the captured range, select the correct physical notebook, and choose **Move captured range**. InkRelay verifies that the range still belongs to the displayed source copy, appends a correction to `notebook-instances.json`, and rebuilds the in-memory projections from canonical events. The raw JSONL remains unchanged, and restart/replay applies the correction deterministically.

The metadata schema is `inkrelay.notebook_instances.v3`. Existing v1 files migrate with an empty correction history; v1 and v2 notebook instances migrate as unarchived and become v3 on the next metadata update. Reassignments retain their source and target instance, page, pen/session identity, sequence bounds, and timestamp. Reassigning the same range again appends another correction instead of editing history; the latest matching correction wins.

To remove a physical notebook from the visible shelf, open its `•••` menu and choose **Archive notebook**. Archiving is reversible metadata: raw events, reconstructed pages, browser-local Excalidraw scenes, language reviews, and Obsidian exports are not deleted. Expand **Archived notebooks** in the shelf and choose **Restore** to return it. An archived instance cannot receive new capture or reassignment until restored; when the active instance is archived, another visible copy of the same paper identity becomes active when available.

The repair control operates on one contiguous capture range on the selected page. If two same-identity physical notebooks were mixed inside one undifferentiated range, the pen data contains no reliable boundary and InkRelay cannot infer where one physical copy ends. Import each copy after selecting it whenever possible. Bulk multi-page correction and overlap-assisted suggestions are not implemented yet.

Existing language reviews and Obsidian exports are retained as historical projections when ink is reassigned. Review or export the corrected target page again when a current projection is needed; cleanup remains explicit and non-destructive. If the moved range contains a workflow action, the append-only outbox records a newer routing projection under the same intent ID so readers use the corrected physical notebook without creating a second logical request.

For UI/API work without a real pen:

```dotenv
INKRELAY_BLUETOOTH_ENABLED=false
OBSIDIAN_VAULT_PATH=./tmp/demo-vault
INKRELAY_DATA_PATH=./tmp/inkrelay-data/raw
```

## Prepare macOS Bluetooth

`pnpm dev:server` and `pnpm build` run the platform-aware native build automatically. Use `pnpm build:macos` to compile/sign the Swift helper explicitly. Linux skips that build step. Apple Command Line Tools and macOS 12+ are required; no Python Bluetooth dependencies are introduced.

Start the server with Bluetooth enabled, allow the macOS consent prompt, then use **Get notes → Scan for pens**. After a denial or a powered-off adapter, fix the setting and use **Retry Bluetooth**. The helper supports both Neo UUID generations; canonical pen identity still comes from protocol negotiation. See [macOS setup, diagnostics and hardware checklist](macos-hardware.md) for details and current validation status.

## Prepare Linux Bluetooth

Confirm that BlueZ sees the controller:

```bash
bluetoothctl show
timeout 15s bluetoothctl scan on
```

Turn the pen on before scanning. Disconnect it from Neo Studio and phones/tablets; the tested pen supports a single active application connection.

InkRelay must access the system bus at `/run/dbus/system_bus_socket`. Run the server as the logged-in desktop user, not root. Containers and restricted sandboxes need explicit system-D-Bus and Bluetooth access or should set `INKRELAY_BLUETOOTH_ENABLED=false`.

Follow [Neo/LAMY hardware on Linux](neo-linux-hardware.md) for the full connection and capture procedure.

## Automated verification

Run the TypeScript checks and the language-worker tests before handoff:

```bash
pnpm test
pnpm typecheck
pnpm build
cd services/language-worker && uv run pytest
```

Tests run against deterministic fixtures and temporary directories; they must not depend on a real pen, internet access, an Obsidian installation, or a model service.

Before sharing source, run `pnpm publication:check` and follow [the publication guide](publication.md). The source exporter creates an allowlisted copy without Git history, private notes or local configuration. It never creates a repository or pushes code. Dependency/font notice collectors under `scripts/` support the [licensing review](licensing.md); a bundled application needs a separate asset review.

Useful focused commands:

```bash
pnpm test:watch
pnpm exec vitest run tests/neo-protocol-v2.test.ts
pnpm exec vitest run tests/excalidraw-renderer.test.ts
pnpm exec vitest run tests/integration.test.ts
```

Run the fixture-to-vault demo:

```bash
pnpm demo
find tmp/demo-vault/Smartpen -maxdepth 8 -type f -print
```

## Manual hardware regression

Use disposable marks and back up meaningful pen data before protocol work.

1. Start InkRelay and open the Smartpen panel.
2. Scan, select the pen, connect, and authenticate if requested.
3. Write several live strokes, switch physical pages, and verify the matching InkRelay pages appear after pen-up.
4. Name the current physical notebook. If a second physical notebook with the same printed identity is available, select **Start a new physical notebook**, give it a distinct name, write a labeled stroke, and verify both copies retain separate page lists. Switch back and verify later strokes return to the first copy.
5. Deliberately move one disposable captured range to the other copy with **Repair an assignment**. Verify the source page loses only that range, the target gains it, raw JSONL is unchanged, and a restart preserves the corrected assignment. Move it back if desired.
6. Tap each available Paper Controller color and width, then write a labeled sample after each tap. Verify InkRelay's state display and subsequent live strokes.
7. Disconnect InkRelay and write a uniquely labeled offline sample. Select the intended physical notebook in InkRelay before importing it.
8. Reconnect and select **Import stored writing**. Verify the note/stroke counters and the reconstructed page.
9. Import again and verify it reports duplicates rather than adding strokes.
10. Disconnect, open the Neo application, and confirm the offline sample remains available there. Do not expect the live sample to appear.
11. Restart InkRelay and verify its pages, physical-copy separation, reassignment correction, and active selection reconstruct from the durable stores.
12. Check Paper, Faithful, and Hybrid views; uncertain diagram marks should remain freehand.

Record pen model, firmware, protocol version, paper identity, and expected/actual packet behavior when reporting hardware regressions.

## Development API examples

Replay the bundled fixture:

```bash
curl -X POST http://127.0.0.1:4317/api/replay/sample
curl http://127.0.0.1:4317/api/state
```

Export a reconstructed page (replace the identifiers with a page from `/api/state`):

```bash
curl -X POST http://127.0.0.1:4317/api/export/obsidian \
  -H 'content-type: application/json' \
  -d '{"notebookId":"NB01","pageId":12}'
```

`POST /api/debug/clear` only clears the engine's in-memory projection. It intentionally leaves JSONL untouched and does not immediately replay it. Restart the server to restore the cleared view. Do not use this endpoint as a delete/reset operation.

## Python workers

Python dependencies use `uv` projects and committed lockfiles exclusively. The implemented multimodal language worker lives at `services/language-worker`; follow [Local language teacher](language-teacher.md) for Docker model startup, GPU variants, configuration, and testing.

The older generic workflow-contract example remains available but is not automatically dispatched. Run it as an alternative service on port 8321:

```bash
cd examples/python-worker
uv sync
uv run uvicorn app:app --host 127.0.0.1 --port 8321
```

Check it:

```bash
curl http://127.0.0.1:8321/health
```

The generic example and language worker both default to port 8321 and should not run simultaneously without changing one endpoint. Keep Python stateless with respect to the vault and return provenance metadata with every result.

## Common failures

### The UI opens but Bluetooth is unavailable

On macOS, check **Privacy & Security → Bluetooth** and follow [macOS troubleshooting](macos-hardware.md). On Linux, use **Get my notes → Retry Bluetooth** after enabling the computer's controller or restarting BlueZ; InkRelay opens a fresh system-bus connection without requiring an application restart. If recovery still fails, check `bluetoothctl show`, system D-Bus access, and `.env`. A sandboxed process can serve the UI while being unable to reach the adapter. When `INKRELAY_BLUETOOTH_ENABLED=false`, the UI reports Bluetooth as disabled and a server restart with the setting enabled is required.

### Scanning finds nothing

Wake the pen, keep it close, disconnect other apps, and retry. Confirm `bluetoothctl scan on` sees it. Neo/LAMY names help discovery, but the adapter also evaluates service characteristics when connecting.

### Connect appears stuck or fails during negotiation

Power-cycle the pen, disconnect competing clients, and reconnect. The manager times out stalled BlueZ initialization/negotiation rather than blocking the web server indefinitely. Inspect backend logs for the exact command/characteristic failure.

### Strokes count up but nothing is visible

A page stroke completes only on `pen_up`. If the counter is changing but the page is blank, inspect page selection and server warnings, then verify the paper identity/dimensions. A malformed or interrupted stroke is intentionally discarded rather than fabricated.

### Ink appears at the wrong scale or position

Open **Session → Paper product** and register the selected notebook's physical width and height. Confirm that width and height reflect the viewed orientation. If an unknown-paper warning remains, verify that the profile identity exactly matches the selected page. For a consistent scale or origin offset, recalibrate from the two ordered corner crosses. Rotation, skew, curved-paper distortion, and page-specific margins are not modeled; do not edit canonical event coordinates.

### Controller color/width is wrong

The tested LAMY card mapping applies only to notebook `NEO_3_1013_1`, page 11. Enable action-zone overlays and compare the tap coordinates with `config/action-zones.json`. Do not expect controller choices made while offline to be recoverable if the pen did not store them.

### Old pages disappear after debug clear

Canonical events were not deleted. Restart the server to replay them. If pages are still absent, confirm `INKRELAY_DATA_PATH` is unchanged and inspect its `.events.jsonl` files without editing them.

### Port already in use

Stop the old InkRelay process or set a different `INKRELAY_PORT`. In development, also update `apps/web/vite.config.ts` if the API port changes because the proxy target is currently defined there.

## Adding functionality

- New pen: emit the versioned core event from `packages/adapters`; keep vendor packets out of the engine.
- New paper: add catalog/profile-driven dimensions, transform, orientation, and zones rather than UI constants.
- New action: extend core types, router behavior, exports, replay, and idempotency tests.
- New renderer: consume `SmartpenPage`, retain source-stroke links, and keep user edits in a separate durable layer.
- New AI flow: consume a durable workflow intent, return validated results/provenance, and let TypeScript write projections.

Review [Design contracts](design-contracts.md) before changing persistence, identity, protocol acknowledgement, or coordinate semantics.

## Automatic paper definitions

`INKRELAY_PAPER_DEFINITIONS_PATH` defaults to `tmp/inkrelay-data/paper-definitions.json`. This versioned local import history is separate from `INKRELAY_PAPER_PROFILES_PATH`; include both in backups. `INKRELAY_AUTOMATIC_PAPER_ENABLED=false` disables automatic references and imported definitions on restart while retaining manual profiles and all stored data.

Use **Session → Paper product → Import notebook definition**, or `POST /api/paper/metadata` with `{ "xml": "<nproj …>…</nproj>", "notebookId": "NEO_…" }`. `notebookId` is optional; if present, a mismatched file is rejected. Files are limited to 2 MB and require supported unrotated nproj 2.x geometry. `GET /api/paper/profiles` includes the effective automatic `definitions` with provenance. The latest definition replaces the earlier one for that notebook; imports for split segments are not merged. No pen data or handwriting is uploaded anywhere.

See [geometry, compatibility and manual regression](neo-linux-hardware.md#metadata-geometry-and-compatibility) before adding paper references or changing the parser. The fixture `fixtures/synthetic-paper.nproj` is deliberately a synthetic test product, not a real vendor catalog entry.
