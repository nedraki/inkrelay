# InkRelay roadmap

The destination is an offline-capable paper interface for computing: users can write naturally away from a computer, then InkRelay reconstructs the notebook locally and executes explicit paper-triggered flows when processing becomes available. Live capture remains valuable for immediate interaction, diagrams, and temporary printed surfaces.

This roadmap is directional rather than a release promise. Preserve the contracts in [Design contracts](design-contracts.md) while replacing MVP implementation choices.

## Product principles

- Paper remains useful with no network and no active computer connection.
- Users retain the source data and can understand which application owns each copy.
- Ink is captured once and interpreted many ways without destructive conversion.
- Intelligence is opt-in, observable, replayable, and attributed.
- A false recognition should never destroy handwriting.
- Compatibility and portability matter more than vendor lock-in.

## Phase 1: trustworthy notebook foundation

This is the next priority because AI and richer projections depend on correct page identity and durable scene state.

### Paper catalog and calibration

- Extend the implemented local `.nproj` imports and three measured product references into a broader verified catalog, with an explicit optional metadata download source.
- Extend the implemented two-anchor X/Y scale and origin calibration with rotation/skew, explicit margins, page ranges, spread relationships, and printable command surfaces.
- Add calibration history/preview and explicit rollback around the implemented versioned profile revisions.
- Extend the implemented capture-range reassignment with overlap-assisted prompts and bulk multi-page correction.
- Move the LAMY controller ID and bounds out of the web UI into profile/catalog data.
- Allow unknown paper with a clearly labeled fallback canvas.

### Durable Excalidraw projects

- Define a versioned server-side scene format with source-stroke relationships.
- Separate generated elements from user-authored edits and recognition overrides.
- Persist edits atomically, include them in backup/export, and offer `.excalidraw` export.
- Project diagrams into Obsidian without making the browser cache authoritative.
- Preserve edits across renderer upgrades through migrations and stable generated IDs.

### Capture and recovery operations

- Add first-class data backup, restore, retention, and explicit deletion flows.
- Add a page/session browser and import history.
- Replace debug clear with safe rebuild/reindex commands.
- Record capture-source and import metadata visibly.
- Test interrupted offline transfers and resume behavior on more firmware versions.

## Phase 2: better diagrams and paper interaction

### Recognition

- Expand deterministic fixtures from real handwriting styles.
- Add confidence/debug overlays and user promote/revert controls.
- Improve multi-stroke rectangles, circles, arrows, dashed connectors, arrow bindings, and grouping.
- Recognize common diagram relationships while keeping labels as handwriting.
- Support explicit paper gestures or controller modes when geometry alone is ambiguous.

Clean OCR-rewritten diagrams are deliberately deferred. The target remains the agreed hybrid: native shapes/connectors plus faithful handwritten text.

### Action system

- Create a profile-aware action-surface designer and printable templates.
- Add regions, selections, page/spread actions, undo/cancel, and confirmation semantics.
- Persist action-state transitions explicitly so replay is independent of future config edits.
- Separate harmless local transformations from consequential external actions requiring review.

### Multiple pens and inputs

- Extend the implemented `NeoPenTransport` platform boundary (Linux BlueZ/macOS Core Bluetooth) with a Windows GATT transport and a capability report; finish and record cross-platform hardware acceptance.
- Test additional Neo protocol-v2 devices and document firmware differences.
- Add transports/adapters for other manufacturers where protocol access and licensing permit.
- Support multiple paired pens without mixing session state.

## Phase 3: local intelligence pipeline

### Durable workflow runner

- Schedule queued intents with explicit states, leases, retries, cancellation, and idempotent result commits.
- Detect whether the requested page/input changed before committing a result.
- Provide a review inbox for actions queued on paper while offline.
- Keep TypeScript responsible for orchestration and vault writes.

### Python and local models

- Wire the existing versioned HTTP executor to the queue.
- Add capability discovery for OCR, vision, embeddings, and language models.
- Prefer local processors by default; make any remote endpoint explicit per workflow.
- Sandbox inputs/outputs, set resource/time limits, and redact secrets from logs.
- Store pipeline, prompt, processor, model, confidence, and source-stroke provenance.
- Add an explicit re-review/model-comparison control that bypasses the page-and-settings cache without deleting prior reviews or provenance.

### Initial flows

- Experimental whole-page language-teacher review is implemented: direct vision transcription, grammar corrections, explanations, examples, and durable provenance.
- General handwriting OCR as a sidecar, never a replacement for ink.
- Extract tasks with links to page and source region.
- Summarize a page or selected region.
- Suggest Obsidian links and tags for approval.
- Interpret a handwritten command only when backed by an explicit action gesture/zone.

## Phase 4: Obsidian and long-term use

- Build an Obsidian plugin for status, import, review, scene editing, and provenance display.
- Support incremental updates without rewriting unrelated user content.
- Add notebook/spread navigation, backlinks, search, and source-region deep links.
- Define portable archive/export formats independent of Obsidian.
- Package the local service for reliable desktop startup and upgrades.

## Engineering evolution

These changes become useful as the corpus grows:

- Add a transactional metadata/index database while retaining import of existing JSONL.
- Replay only affected sessions and maintain rebuildable page checkpoints.
- Replace full SSE snapshots with versioned deltas and backpressure.
- Stream partial active-stroke previews without treating incomplete ink as durable strokes.
- Isolate device sessions so one stalled pen cannot block other ingestion.
- Add property/fuzz tests for packet parsing and corrupted JSONL recovery.
- Add schema migration tooling and golden compatibility fixtures.
- Add structured telemetry stored locally and disabled/exportable by the user.

## Research tracks

These can be prototyped without changing the canonical model:

- Paper regions as offline buttons, forms, sliders, and spatial prompts
- Handwritten workflow composition and agent handoff diagrams
- Live co-creation where model output is shown digitally while input remains physical
- Bi-directional links between physical page regions and digital objects
- Personal handwriting/gesture adaptation trained locally
- Multi-modal context combining ink timing, pressure, page position, and later annotations

Research code must still preserve source events, expose provenance, and avoid silently turning uncertain interpretation into external effects.

## Explicit non-goals for now

- Simulating an offline pen while a live BLE session is active
- Modifying pen firmware or reverse-engineering destructive memory commands
- Guaranteeing that live InkRelay strokes appear in proprietary Neo applications
- Replacing all handwriting with OCR text
- Making cloud services mandatory
- Treating generated diagrams or AI output as more authoritative than physical ink

## Milestone acceptance criteria

A roadmap item is not complete merely because its UI works. It should include:

- restart/replay behavior;
- duplicate and interrupted-import behavior when relevant;
- schema/provenance documentation;
- deterministic automated tests;
- user-visible failure and recovery behavior;
- migration of existing data or scenes;
- a manual hardware test when capture, paper, or protocol behavior changes.
