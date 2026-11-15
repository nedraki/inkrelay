# Design contracts and change boundaries

This is the decision record for changes to InkRelay. It separates product principles from replaceable MVP choices. A change is welcome when it advances the product without weakening the contracts below.

## Must be preserved

### Local-first ownership

Core capture, replay, page reconstruction, and export must work without a cloud account. Networked or hosted processors may be optional adapters, never a prerequisite for access to a user's ink.

The default server bind remains loopback. Exposing InkRelay to a LAN requires explicit configuration plus an authentication and origin-security design; changing `INKRELAY_HOST` to `0.0.0.0` is not a harmless convenience.

### Raw ink before interpretation

A validated pen event must be durably appended before stroke/action/workflow processing succeeds. If later processing fails, replay must be able to try again from captured input.

Raw session history is append-only. Corrections such as newly learned color may append a newer record with the same identity; readers select the latest one. Do not edit old JSONL lines in place.

OCR, shape recognition, summaries, tasks, links, and user-interface scenes are projections. None may replace or mutate the event source.

### Stable identity and repeatable import

Event identity is `(penId, sessionId, sequence)`. Stroke identity is derived from the session and first dot sequence. Paper action and workflow intent IDs are also deterministic from their inputs.

Importing the same offline data twice must not duplicate strokes, actions, or workflow intents. Any alternative database or queue must retain this property.

### Non-destructive pen synchronization

Offline download must request retention on the pen. A success acknowledgement must be sent only after every event represented by the packet has been accepted or safely identified as already durable. InkRelay must not erase pen memory, change firmware, or claim cross-app availability for live data it cannot verify.

### Source time and provenance

Preserve the pen timestamp separately from import and processing time. Future OCR/AI results must record processor identity and version, model identity/version when applicable, prompt/pipeline version, input scope or source stroke IDs, creation time, and confidence where meaningful.

Users must be able to distinguish source ink, deterministic transformations, and model-generated content.

Physical-notebook separation must not rewrite the source `notebookId`. App-level physical instance assignments are versioned metadata over canonical events, with explicit session/sequence boundaries so replay does not depend on whichever notebook is active later.

Language reviews must retain their page digest, source stroke IDs, requested and detected languages, model/provider, pipeline version, and input mode. A changed page makes the old review stale; it must not silently relabel the old result as current.

### One writer for durable application output

TypeScript owns canonical state, workflow lifecycle, and vault writes. Python or other workers receive versioned input and return structured results; they do not edit the vault directly. This avoids concurrent writers and keeps retries/idempotency in one place.

### Safe regeneration

Generated artifacts may be replaced atomically. An Obsidian generation must be complete before its visible page note points to it, and user-owned page notes must never be overwritten. Legacy vault exports and old generations require an explicit, recoverable retention or cleanup policy rather than incidental deletion. Never silently discard browser Excalidraw edits: until scenes are server-backed, label them as browser-local and provide an explicit migration/export path before changing their storage key or renderer version.

### Version external contracts

Persisted events, actions, workflow payloads, worker requests, exported machine-readable files, and future scene formats need explicit schema versions. Add migrations or compatible readers before introducing a breaking version. Do not reinterpret old coordinates or IDs based only on new global defaults.

### Conservative interpretation

When diagram recognition is uncertain, retain faithful ink. It is better to miss a shape than to replace handwriting with an incorrect shape without user confirmation. Recognition improvements require deterministic fixtures covering accepted and rejected examples.

## Product behavior to respect

- Live mode prioritizes immediate interaction and saves to InkRelay's canonical store.
- Offline mode prioritizes delayed capture and compatibility with other pen software.
- The user can use both modes, but InkRelay must explain that tested Neo firmware does not retain all live-session strokes for later offline sync.
- Paper Controller choices affect subsequent strokes during the active InkRelay session. Offline imports cannot claim to reconstruct controller state the pen did not store.
- A stroke becomes a page element on `pen_up`; partial dot rendering is not currently promised.
- Command surfaces should not appear as normal notebook content unless a diagnostic view explicitly requests them.
- Human-readable Obsidian notes and machine-readable sidecars describe the same reconstructed page.

## Safe to change

These are implementation choices and may be replaced with tests and migration care:

- Fastify, React, Vite, SSE, and the exact UI layout;
- JSONL as the physical store, provided the old corpus can be imported and append-before-process/idempotency remain;
- the in-memory page index and full startup replay;
- geometry-recognition thresholds and algorithms;
- SVG path generation and visual styling;
- default ports and folder naming through compatible configuration;
- the workflow scheduler, retry policy, and supported worker runtimes;
- the exact Obsidian note template outside protected user sections;
- BlueZ transport internals and support for multiple concurrent pens;
- page calibration/profile implementation;
- action-zone authoring format, with a migration for existing configurations.

## Changes requiring an explicit design and migration

Do not make these as incidental refactors:

- changing any persisted schema, identity formula, coordinate meaning, or timestamp meaning;
- changing normalized notebook/page identity;
- relocating or deleting canonical data;
- acknowledging an offline packet before durable ingestion;
- enabling deletion of pen data;
- making cloud access mandatory;
- allowing a worker or browser to overwrite the vault independently;
- replacing source strokes with OCR/AI/shape results;
- treating browser `localStorage` as durable scene storage;
- changing renderer element IDs/version while users may have cached Excalidraw edits;
- binding the server beyond loopback without authentication, authorization, and CORS review;
- incorporating or distributing vendor SDK code without a licensing decision.

An explicit design should state the user-visible effect, old/new schema, migration and rollback, failure behavior, provenance impact, and tests.

## Extension rules

### Add a pen

Implement transport/parsing behind an adapter that emits valid `PenDotEvent`. Preserve the source's stable pen/session/sequence identifiers or define a deterministic equivalent. Add packet fixtures and tests for malformed input, time ordering, page changes, and duplicate transfers. Do not add vendor cases to the engine.

### Add a paper product

Create a catalog/profile that maps the paper identity to dimensions, orientation, coordinate transform, and optional controller/action zones. Keep raw normalized coordinates recoverable and version/calibrate the profile. Avoid adding another notebook constant to the UI.

### Add an action

Extend the versioned domain type, route it deterministically, decide whether the triggering stroke is ink, action, or both, persist it in exports, and test replay/duplicates. Actions that launch external effects should first create a durable intent and should support user review where the effect is consequential.

### Add AI or Python processing

Consume a durable intent, use an explicit input scope, return validated structured data plus provenance, and let the TypeScript coordinator record status and write outputs atomically. Design cancellation, retry, timeout, stale-input detection, and user approval before automatic execution.

Python projects use `uv` and committed lockfiles. Local model weights run from a container-managed volume. Pointing the image-review worker at a remote endpoint changes the privacy boundary and must be an explicit user configuration.

### Add a projection

Accept `SmartpenPage` or an explicitly versioned derivative. Maintain links back to source stroke IDs. Keep it regenerable and ensure user modifications have a separate durable layer rather than modifying canonical ink.

## Definition of done

For implementation changes:

1. Tests demonstrate intended behavior and a relevant failure or replay case.
2. `pnpm test`, `pnpm typecheck`, and `pnpm build` pass.
3. Hardware-sensitive changes include a manual test recipe and do not require a pen for the automated suite.
4. Persisted/API changes update their schema, migration, fixtures, and documentation.
5. User-facing behavior and known limitations are reflected in the README or relevant guide.
6. No secrets, local vault contents, Bluetooth identifiers, or canonical test writing are committed accidentally.

## Current known debts

- Automatic paper definitions support explicit page ranges, cropped bounds and axis-aligned scale/origin mapping; existing manual profiles retain priority. Rotation/skew, spread metadata and interactive calibration history are not implemented. Compatibility and rollback are documented in `docs/neo-linux-hardware.md`.
- Capture ranges can be reassigned between physical notebooks, but overlap-assisted suggestions and bulk multi-page correction are not implemented.
- The Paper Controller notebook ID is hardcoded in the web UI.
- Excalidraw edits are not server-backed or included in vault export.
- Workflow execution and result projection are not wired.
- Full event replay and full SSE snapshots will not scale indefinitely.
- The debug-clear route can temporarily empty reconstructed pages until a process restart; it is not a user reset feature.
- Physical notebooks can be archived and restored as presentation metadata, but there is no supported permanent deletion, retention-policy, or application-level backup/restore interface.
- Only Neo protocol v2 is supported directly, and only one pen has been hardware-tested extensively.
