# Neo/LAMY hardware on Linux

This guide covers Linux/BlueZ. For the native Core Bluetooth transport, see [macOS hardware setup](macos-hardware.md). InkRelay connects directly to modern Neo protocol-v2 BLE pens through BlueZ on Linux. Development and repeated manual tests currently use a LAMY safari all black ncode pen. Treat other model/firmware combinations as compatible candidates requiring verification, not as guaranteed support.

## Safety and data ownership

- Live dots and downloaded dots enter the same versioned `PenDotEvent` store.
- Valid events are appended before stroke/action processing.
- Offline synchronization requests that the pen retain its stored data after transfer.
- An offline packet is acknowledged as successful only after its dots are durably ingested.
- Event identity prevents repeat transfers from duplicating canonical dots or strokes.
- Original pen timestamps are retained; import/processing time is separate metadata.
- InkRelay does not update firmware or issue pen-memory deletion commands.

Canonical logs are append-only. If a repeat packet supplies a color missing from an earlier copy, InkRelay may append an enriched record with the same identity; replay selects the newest record.

## Linux prerequisites

The backend must run on the Linux host with access to the system D-Bus and BlueZ. A container or sandbox without `/run/dbus/system_bus_socket` cannot reach the Bluetooth controller.

Check the host:

```bash
bluetoothctl show
timeout 15s bluetoothctl scan on
```

Turn the pen on before scanning. Disconnect Neo Studio and phones/tablets while testing; the tested pen should have one active application client.

Ubuntu desktop installations normally authorize the logged-in user through Polkit. Do not run the whole InkRelay server as root. If the API says the system bus is inaccessible, run it outside the container/sandbox or explicitly configure that environment's D-Bus/Bluetooth access.

## Connect and capture

1. Run `pnpm dev` and open <http://127.0.0.1:4318>, or run `pnpm build && pnpm start` and open <http://127.0.0.1:4317>.
2. In the Smartpen card, select **Scan for pens** with the pen awake.
3. Select the discovered device and choose **Connect**.
4. If requested, enter the pen password.
5. Write on Ncode paper. A page element appears after the stroke finishes at pen-up.
6. For writing made while disconnected, select **Refresh stored list** if needed and then **Import stored writing**.
7. Wait for the import summary before disconnecting.

Connection state reports the model, firmware, protocol version, battery, storage, and offline-data setting when the pen supplies them. Discovery understands both observed generations of protocol-v2 GATT UUIDs and considers Neo/LAMY/NWP device names.

## Live and offline modes

### Live mode

InkRelay enables pen data streaming and durably stores the normalized dots it receives. This is best for immediate feedback, live diagrams, controller interaction, and temporary printed paper.

On the tested LAMY/Neo behavior, writing transmitted during an active app connection is generally not also stored as offline pen data. Consequently, InkRelay can replay it after restart, but a later Neo application sync may not receive it. InkRelay cannot safely fake an offline state while maintaining the live protocol session.

### Offline import

Write with no app connected, then connect InkRelay and select **Import stored writing**. InkRelay requests retention and uses deterministic identifiers, making the transfer non-destructive and repeatable. This is the recommended path when the same physical writing must later be synchronized into both InkRelay and Neo software.

The exact proprietary-app behavior still depends on firmware and app settings. Verify important workflows with labeled samples before relying on them.

The UI reports two related counters during import. **Processed** advances as strokes are reconstructed or identified as duplicates. **Durably acknowledged** advances when a complete pen packet has been persisted and positively acknowledged; it can pause while a larger packet is being written. The final summary separates new strokes from writing already present in the canonical store.

## Paper identity and coordinates

Neo identifies paper with `section`, `owner`, `note`, and `page`. The current adapter maps those fields to:

```text
notebookId = NEO_<section>_<owner>_<note>
pageId     = <page>
```

Neo integer and fractional positions are converted at 10 `app_px` per reported unit. The default 1480 × 2100 projection matches the tested 148 × 210 mm sample paper. It does not prove that every Neo notebook has those dimensions.

InkRelay resolves page geometry locally, in this order:

1. A saved manual profile in `paper-profiles.json`, including any measured calibration. Existing dimension-only profiles also keep their previous identity transform.
2. An imported `.nproj` notebook definition, matched by the full section/owner/note identity and the actual page range.
3. A bundled **measured reference** for the exact identities `NEO_3_1012_3017` (145 × 210 mm), `NEO_3_27_701` (130 × 210 mm), and `NEO_3_27_747` (190 × 250 mm). These reuse InkRelay's previous two-cross measurements, assume uniform interior pages 1–511, and are not official Neo metadata. Different owners, similar book codes, and cover page 0 are not inferred.
4. The configured fallback canvas and identity transform, visibly labelled unknown paper.

For supported paper, write normally: no new corner crosses or dimension entry are needed. **Session → Paper product** shows whether mapping is automatic from metadata, automatic from a measured reference, or a saved manual override. Previously calibrated notebooks keep their exact saved settings.

For additional products, obtain the matching `.nproj` definition and use **Session → Paper product → Import notebook definition** once. InkRelay stores the parsed geometry locally; subsequent capture and restart/replay require no network. There is no universal vendor catalog connection or automatic download yet. Metadata for the three measured products has not been independently obtained from Neo. Unknown page dimensions cannot be recovered reliably from handwriting bounds alone.

### Metadata geometry and compatibility

The independent adapter parser follows Neo's published [NoteServer geometry conversion](https://github.com/NeoSmartpen/WEB-SDK2.0/blob/master/src/API/NoteServer.ts) and [screen mapping](https://github.com/NeoSmartpen/WEB-SDK2.0/blob/master/src/PenCotroller/PenHelper.ts). One Ncode unit corresponds nominally to `56 / 600 * 25.4 = 2.370666…` mm. The `.nproj` page bounds and crop margins use 72-dpi points; margins are interpreted as left, top, right, bottom, matching `extractMarginInfo` (some sample-file comments disagree with the SDK). Fractional geometry is retained. Segment start pages are respected; only the file's explicit pages are mapped. Rotation and malformed, ambiguous, non-contiguous, oversized or external-entity XML are rejected. Symbols, scripts, URLs and commands in the file are ignored, never executed or fetched.

Canonical coordinates **remain ten times the reported Ncode coordinate**, including all existing logs and new capture. The physical-unit conversion and origin subtraction happen only in the page projection. Changing the adapter's multiplier would reinterpret old coordinates and is deliberately avoided. Manual profiles remain authoritative and are not rescaled a second time.

Imported geometry is stored beside raw data in `paper-definitions.json`, schema `inkrelay.paper_definitions.v1`: `{ schemaVersion, imports: PaperDefinition[] }`. Each definition has a source SHA-256 digest, provenance, dimensions and positive axis-aligned transforms per page range. Imports retain history; the latest complete definition for a notebook identity wins, including when a file covers only one segment. Reimporting the currently active file is idempotent. Imports are validated before atomic publication. Reprojection removes the previous transform before applying the new one and leaves canonical files, stroke IDs, actions and manual profiles unchanged.

**Migration and rollback:** the existing `inkrelay.paper_catalog.v2` manual file is unchanged; no migration or write is required. On upgrade, known identities without a manual profile can gain the bundled reference mapping. Existing manual profiles, unknown identities and controller-card coordinates retain their previous behavior. Set `INKRELAY_AUTOMATIC_PAPER_ENABLED=false` and restart to restore manual/fallback-only behavior without deleting any metadata. Back up `paper-definitions.json` before imports; restore that file and restart to roll back metadata, or reimport an earlier definition. Existing browser-local Excalidraw scenes retain cached positions rather than silently discarding edits; Original/SVG and new exports reflect the current mapping. A scene migration remains separate work.

Manual dimensions and two-cross calibration remain available as a fallback under **Manual dimensions and calibration**. Draw two two-stroke crosses, top-left then bottom-right, centred 10 mm from the edges. The saved axis-aligned transform affects derived strokes only; rotation, skew and curved-paper distortion remain unsupported.

### Manual regression for automatic paper mapping

1. Back up the local metadata files. Connect on the Linux/BlueZ hardware host and write normally on a supported notebook, without new crosses; check dimensions, relative ink positions and mapping provenance.
2. Switch between products and pages. Check portrait/landscape metadata and an out-of-range or unknown page; the latter must remain a labelled fallback. Confirm the saved manual calibration still wins for previously calibrated products.
3. Tap controller colors/widths and write after each tap; controller coordinates must retain their calibrated mapping.
4. Disconnect, write offline, reconnect and perform a non-destructive import. Verify positions match live capture, then import again and verify deduplication.
5. Import a matching metadata file in Session and restart. Confirm page geometry survives and raw JSONL is byte-for-byte unchanged. An invalid, rotated or wrong-identity file must leave the active mapping intact.
6. Check Original/SVG and Obsidian output. Confirm existing browser edits are retained. Disable automatic mapping and restart to test rollback; restore the setting afterward. Pen memory must never be deleted.

Neo does not report a serial number for a physical notebook copy. If another notebook reuses the same `section/owner/note`, select or create the physical copy under **Get my notes → Physical notebook** before writing live or starting its offline import. InkRelay records the selection at the next event's session and sequence boundary while preserving the original paper identity. A misfiled contiguous capture range can later be moved through **Repair an assignment**; this appends correction metadata and rebuilds projections without changing raw pen events. Writing imported from multiple same-identity copies inside one undifferentiated range cannot be separated reliably because the pen provides no physical-copy boundary.

## LAMY Paper Controller

The controller card is itself Ncode paper. Tapping it produces normal pen coordinates with its own paper identity; the pen does not transmit a semantic message such as “blue.” InkRelay interprets a short stroke inside calibrated bounds as an action.

The current profile is in `config/action-zones.json` for:

```text
notebookId = NEO_3_1013_1
pageId     = 11
```

It maps Fine, Medium, Wide and the card's displayed colors. `apps/web` currently hides that notebook from the normal page list. This measured mapping is not an official-paper-catalog integration and may vary with a different controller revision.

During an InkRelay live session, a successful tap changes InkRelay's color/line state for subsequent strokes. During offline writing, those controller choices are not reliably stored as semantic state in the pen history. Offline stroke packets can include a recorded physical ARGB ink color, but InkRelay cannot reconstruct controller transitions that are absent from the transfer. Testing with Neo's own sync showed similar limitations for offline controller color choices.

To recalibrate, temporarily display action-zone overlays, record the controller page identity and tap coordinates, and change only the matching scoped zones. Add tests before changing action semantics.

## Pen API

```text
GET  /api/pens
POST /api/pens/bluetooth/retry
POST /api/pens/scan                 { "durationMs": 10000 }
POST /api/pens/connect              { "deviceId": "..." }
POST /api/pens/disconnect
POST /api/pens/authenticate         { "password": "..." }
POST /api/pens/offline/refresh
POST /api/pens/offline/sync
```

Pen status is also included in `/api/state` and the server-sent snapshot stream at `/api/events`.

## Supported protocol boundary

The implemented hardware path covers Neo BLE protocol v2 with its observed older and current GATT UUID sets. Very old Neo protocol-v1/RFCOMM pens need a separate transport/parser and currently fail when protocol-v2 characteristics cannot be found. Pens from other manufacturers require adapters that emit the same canonical event schema.

Protocol work should use packet fixtures and never require live hardware in the automated suite. A new adapter must define stable identities, coordinate conversion, timestamp semantics, capability reporting, malformed-packet behavior, and offline acknowledgement safety.

## Troubleshooting

- **Bluetooth unavailable:** use **Get my notes → Retry Bluetooth** to create a fresh BlueZ system-bus connection, then scan again. If it still fails, verify `bluetoothctl show`, system-D-Bus access, and that `INKRELAY_BLUETOOTH_ENABLED` is not `false`.
- **No devices:** wake/power-cycle the pen, disconnect competing apps, and repeat the scan.
- **Connection stalls:** power-cycle, ensure no phone is reconnecting automatically, and inspect backend logs for negotiation timeouts.
- **Stroke counter increases but page is blank:** finish the stroke, select the actual page, inspect warnings, and verify the paper identity/dimensions.
- **Wrong page or scale:** the paper may need a catalog/calibration profile; changing canvas size alone does not change coordinate normalization.
- **Offline packet reports more bytes than declared:** some recent Neo firmware appends opaque bytes after the declared compressed data block (observed as roughly 502 extra bytes). InkRelay follows Neo's current Web SDK behavior: it reads only the declared block and acknowledges it only after decompression, declared-size validation, stroke parsing, dot checksum validation, and durable event ingestion. The appended bytes are not added to the canonical corpus. Live mode remains a safe workaround on older InkRelay builds.
- **Wrong controller choice:** verify the controller identity/page and bounds with the overlay. A different controller revision needs its own profile.
- **Offline import disabled:** enable offline storage in the pen's settings using supported vendor software, then reconnect.
- **Import progress appears stuck:** keep the pen awake and connected, then check `GET /api/pens`. Packet-level acknowledgement can pause while InkRelay processes a large packet. Do not clear state or delete pen memory. If `sync.active` becomes false, inspect its final counts and error. A failed or interrupted import can be safely retried because InkRelay requests retention and deduplicates event identities.
- **Imported strokes are not on the visible canvas:** check the page selector. One stored notebook transfer can contain several physical pages, and InkRelay keeps each `NEO_<section>_<owner>_<note>` / page combination separate. Confirm page counts through `GET /api/state`; canonical JSONL files under `INKRELAY_DATA_PATH` remain the recovery source.
- **Imported page disappears after restart:** confirm `INKRELAY_DATA_PATH` has not changed and inspect its event files without editing them.

## Protocol provenance and licensing

The TypeScript implementation was developed against observed hardware behavior and packet information available in NeoLAB's public UWP SDK, including command identifiers, framing, GATT UUIDs, and field layouts. The referenced vendor repository states GPL-3.0 licensing for non-commercial use and directs commercial users to contact NeoLAB for commercial licensing. Review the current upstream terms and obtain legal advice before commercial distribution or copying vendor implementation code.

- Vendor reference: <https://github.com/NeoSmartpen/UWP-SDK>
- Neo technology overview: <https://neolab.net/en/technology>
