# Paper-first interface direction

InkRelay is not a conventional dashboard. Its primary purpose is to protect the cognitive value of writing on paper, then offer progressively deeper digital tools when the writer deliberately asks for them. The interface should feel closer to a quiet desk than a control room.

## Product posture

The physical notebook is the source of thought. InkRelay makes that source visible, durable, replayable, and available to later workflows without demanding that the writer organize or process everything while writing.

The interface therefore follows this sequence:

1. **Paper** — inspect the faithful source, follow live writing, replay it, and verify capture.
2. **Ink** — continue with editable freehand material without interpreting it.
3. **Diagram** — introduce conservative digital structure while retaining uncertain ink.
4. **Review** — enter a deliberate deep-work flow such as language feedback.

The mode order expresses increasing digital interpretation. New modes should earn a place in this sequence rather than becoming unrelated tabs.

## Interface hierarchy

The workspace always owns the largest possible area. Persistent interface chrome is limited to:

- the InkRelay wordmark and local-engine state;
- a compact shelf of physical notebooks;
- the four page modes, presented as page-edge tabs;
- the selected page and mode-specific actions.

The shell should read as a notebook rather than a dashboard: the selected physical notebook is named in the header, its page is the dominant surface, and its digital continuations sit on the page edge. On narrow screens the notebook shelf becomes a compact horizontal row and the page tabs remain attached to the workspace.

Paper source selection separates the physical notebook from navigation within it. The notebook selector never grows one entry per page; previous/next and a numeric page selector operate only on the chosen notebook. Navigation skips uncaptured numeric gaps rather than forcing the user through hundreds of empty page numbers.

Paper, Ink, and Diagram offer an optional **Spread** view. Automatic pairing follows the conventional even-left/odd-right rule, so selecting either page 4 or 5 opens the same 4–5 spread. An uncaptured mate remains a labeled blank sheet rather than being replaced by the next page that happens to contain ink. Users can replace either side manually and restore automatic pairing; that override is a browser-local layout preference keyed to the physical notebook and automatic spread. It never rewrites page identity, strokes, or canonical coordinates. Paper shows a quiet physical fold, and Excalidraw places both independently generated page projections on one editable canvas while retaining every source stroke ID.

**Editable ink** and **Diagram** are full Excalidraw editing modes, not static previews. Choosing either page-edge tab reveals the native Excalidraw canvas and tools for the selected page or spread. Faithful mode keeps every captured stroke as editable freehand ink; Diagram mode adds conservatively recognized shapes and connectors while retaining uncertain writing. Returning to Original or Teacher notes must not discard the browser-local Excalidraw scene. Until server scene persistence exists, the interface continues to describe that scene as a convenience cache rather than canonical or backed-up data.

Operational information uses temporary drawers:

- **Get my notes** contains Bluetooth, live/offline transfer, pen state, interactive color/stroke controls for subsequent ink, and page selection;
- **Get my notes → Physical notebook** names the user's copy, explicitly switches future capture when printed paper identities are reused, and can move a selected page's captured range to another copy without altering source pen events;
- **Session** contains reconstruction readiness, workflow intents, paper actions, warnings, and debug tools.
- **Session → Paper product** shows automatic mapping provenance and dimensions for supported products; a local notebook-definition import can add further paper without calibration crosses. Existing manual profiles keep priority. Manual dimension entry and two-cross calibration remain in a collapsed fallback section; unknown paper remains visibly on the fallback canvas. The source-paper surface derives its aspect ratio from the resolved page dimensions so registered portrait and landscape products are never stretched into the fallback shape.

Drawers overlay the workspace instead of resizing it. They close when the user changes modes or clicks outside them. Closed drawers must be removed from keyboard and accessibility navigation.

**Get notes** is anchored inside the left notebook shelf, beside the edge where its drawer opens. The launcher and details therefore share one spatial origin on desktop and narrow layouts.

Each notebook has a small contextual menu. **Archive notebook** removes it from the active shelf without deleting events or projections. Archived notebooks remain available in a collapsed shelf section with an explicit **Restore** action; permanent deletion is not offered by this reversible control.

## Visual language

- Warm white paper sits on a restrained neutral desk surface.
- Green is reserved for trustworthy local state and primary completion actions.
- Color is used sparingly for semantic feedback, pen ink, warnings, and teacher annotations.
- Typography distinguishes thought from machinery: self-hosted **Literata** for reading and document titles, self-hosted **Manrope** for controls, and monospace only for machine state or provenance. Both primary families use the SIL Open Font License and require no network font service.
- Borders are quiet; elevation communicates temporary layers such as drawers and review notes.
- Avoid decorative illustration, gradients without semantic purpose, oversized metrics, and persistent cards around every piece of information.

## Interaction rules

- Default to **Paper** on launch.
- Never hide the currently selected notebook/page identity.
- Keep capture and import reachable in one action from every mode.
- Preserve the user's page selection when moving between modes.
- Preserve single-page versus spread mode when moving among Paper, Ink, and Diagram; Review remains page-specific.
- Mode-specific controls belong in the workspace bar; diagnostics do not.
- Manual zoom disables auto-follow. Re-enabling follow returns to the documented comfortable zoom.
- Recognition and AI views must keep a clear path back to source paper.
- When an interpretation is uncertain, retain faithful ink and communicate uncertainty without blocking the workspace.

## Deep-work surfaces

Deep-work modes may use more structured layouts inside the workspace, but should retain the quiet shell. The Language Teacher is the reference implementation: it presents the model transcription, focused teacher explanation, and proposed revision as three linked reading surfaces. Selecting a marked phrase in either essay highlights its counterpart and reveals the original wording, suggestion, rule, and examples. Warm marks belong to interpreted source issues; green marks belong to proposed corrections. This comparison remains multilingual and always labels the original as a model transcription rather than physical ink. Machine provenance remains available but secondary, and the interface must not describe a configured remote endpoint as private or local.

Future summaries, research assistance, task extraction, or agent workflows should follow the same pattern:

1. show the source or source-linked result;
2. make interpretation visible and reversible;
3. reveal detail on demand;
4. keep provenance available without making it the main reading experience.

## What may change

Spacing, typography, labels, responsive breakpoints, and drawer contents may evolve through testing. The mode names may be refined if user research finds clearer language.

The following should remain stable unless this document is deliberately revised:

- paper is the default and dominant surface;
- capture/session infrastructure is secondary and on demand;
- deeper tools form a progression from faithful source to interpretation;
- hidden interface must not remain keyboard-focusable;
- no UI cache becomes the only owner of captured ink.
