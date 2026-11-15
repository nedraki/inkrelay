# Neo/LAMY pen capture on macOS

InkRelay has a native macOS Core Bluetooth transport for the same Neo protocol-v2 pens as the Linux transport. The TypeScript protocol parser, canonical ingestion, offline retention/acknowledgement rules and pen identity are shared. Windows native capture is not implemented; replay, storage, projections and export remain usable without Bluetooth.

## Setup

Use macOS 12 or newer with Node.js 22+, pnpm 10 and Apple's Xcode Command Line Tools. The helper builds for the Mac running the build (Apple silicon or Intel); cross-architecture binary distribution is not included.

```bash
# Install Apple's tools if they are missing; follow the system installer.
xcode-select --install
pnpm install
pnpm build:macos
pnpm dev
```

`pnpm dev:server` and `pnpm build` build the helper automatically on macOS. `pnpm start` uses the previous build. Running the server with `tsx` directly requires building the helper first. Linux skips the macOS build step and keeps BlueZ.

Ensure `.env` does not set `INKRELAY_BLUETOOTH_ENABLED=false`. Shell environment takes precedence. The server must run on the Mac, outside a Linux container: macOS Core Bluetooth is not exposed to Docker's Linux VM.

The generated helper lives at `native/macos/.build/InkRelayBluetooth.app/Contents/MacOS/InkRelayBluetooth`. Its local app bundle and embedded Info.plist contain a Bluetooth usage description and stable bundle identifier `net.inkrelay.bluetooth`. The build signs it ad hoc for local development; this is not a Developer ID signed/notarized distribution package. Rebuilding or moving the app may require authorizing Bluetooth again. `INKRELAY_MACOS_BLUETOOTH_HELPER` can point to an explicitly packaged executable; no shell expansion is performed.

On first initialization, allow the macOS Bluetooth prompt. Depending on how Node was launched, macOS may attribute the permission to InkRelay Bluetooth or the parent application/terminal. If denied, allow the relevant application in **System Settings → Privacy & Security → Bluetooth**, then choose **Get notes → Retry Bluetooth**. Initialization allows up to one minute for consent. If that deadline expires, grant permission and retry; a timed-out helper is stopped so it cannot finish a stale connection later.

A read-only authorization probe does not trigger a permission prompt:

```bash
native/macos/.build/InkRelayBluetooth.app/Contents/MacOS/InkRelayBluetooth --probe
```

If the local Command Line Tools have duplicate `SwiftBridging` module maps after an upgrade, the build uses a local VFS overlay to hide the legacy duplicate and a local module cache. It does not edit system headers. Other compiler/SDK mismatches require a consistent Apple toolchain; no automatic toolchain installation or OS setting changes occur.

## Connect and capture

1. Wake the pen and disconnect Neo Studio, phones and other pen clients. Leave macOS Bluetooth enabled.
2. Open **Get notes**, select **Scan for pens**, choose the pen and connect.
3. The shared protocol negotiation retrieves model, firmware, protocol and the pen's hardware identity. Supply a password only if requested; do not guess passwords repeatedly.
4. Write a disposable sample on Ncode paper. Ink appears after pen-up. Check the selected physical notebook before writing/importing when paper identities are reused.
5. For offline writing, disconnect first, write on paper, reconnect, select the correct physical notebook, and explicitly choose **Import stored writing**. The helper itself never requests an import.

Core Bluetooth supplies opaque peripheral UUIDs rather than Bluetooth MAC addresses. The discovery `deviceId`/`address` fields contain that opaque UUID; `paired: false` means pairing state is unavailable to this API, not proof that the pen is unpaired. Canonical `penId` still comes from the Neo protocol version response, so switching Linux/macOS transport does not change existing event identity.

The UI and exports remain browser-based; Safari can use the local interface because Bluetooth runs in the server's helper, not Web Bluetooth.

## Architecture and failure behavior

`NeoPenTransport` selects BlueZ on Linux, Core Bluetooth on macOS, or a clear unsupported-platform implementation elsewhere. The macOS helper handles discovery, characteristic lookup, subscription, ordered chunks and Core Bluetooth flow control. It does not understand Neo commands, save ink, write vault files, or access the network.

The private pipe protocol is version 1: one JSON object per line with `version: 1`. Requests contain `id` and `command`; replies contain `id`, `ok`, and `result` or `error`. Notification events contain a connection token and base64 bytes. Initialization supplies UUIDs and discovery-name fragments from TypeScript. Tokens discard old notifications and queued writes after disconnect/reconnect. Writes are at most 20 bytes per Core Bluetooth call, wait for acknowledgements when supported, and obey `canSendWriteWithoutResponse` otherwise.

A completed BLE write is **not** a durable-ingestion acknowledgement. Only the existing TypeScript Neo protocol sends transfer acknowledgements, after server ingestion returns. Source normalization, stored schema, event/stroke IDs, paper/controller coordinates and retention commands are unchanged. There is no data migration.

Helper crashes, invalid pipe messages and request timeouts reject pending work and invalidate the connection. Retry Bluetooth launches a fresh helper when necessary. Server shutdown closes SSE streams and disposes the helper. Parent-pipe EOF ends the helper; no firmware, pen-memory deletion or other cleanup commands are sent.

Rollback: set `INKRELAY_BLUETOOTH_ENABLED=false` to keep using local replay/export without pen capture. Linux continues selecting the existing BlueZ implementation automatically.

## Hardware validation status

Development checks on Apple silicon verified compilation, local signing, Bluetooth authorization, LAMY safari discovery and Neo protocol negotiation (`NWP-F80`, firmware `3.02`, protocol `2.20`). Non-destructive offline import, repeat-import deduplication, retained pen note listings, helper shutdown and restart/replay were verified. Personal writing, device identifiers, corpus statistics and screenshots from those checks are not distributed with the source.

Live writing, physical page switching and controller taps remain pending macOS hardware checks. Bluetooth-off and interrupted-transfer cases also remain unverified on macOS. Follow the acceptance checklist below rather than treating one tested pen as a guarantee for every device.

## Hardware acceptance checklist

Automated tests use a synthetic pipe peer and protocol fixtures, with no BLE hardware or model dependency. Compilation and discovery alone are not proof of live/offline capture. Record model/firmware/protocol, without committing device identifiers or personal writing, when completing these checks:

1. Build, authorize, scan, connect and confirm version/status negotiation. Verify both observed GATT UUID generations when hardware is available.
2. Write a labelled live sample. Verify pen-up completion, source page identity, dimensions and faithful ink. Switch pages and repeat.
3. Tap each controller color/width, then write a sample; confirm subsequent InkRelay strokes use the chosen style.
4. Disconnect through InkRelay. Write offline while no app is connected.
5. Reconnect, select the intended physical notebook and explicitly import stored writing. Confirm source pages and timestamps, retained pen data and completed acknowledged counts.
6. Import again: canonical events, strokes and actions must not duplicate. Verify the offline sample remains importable by the vendor app afterward.
7. Test pen power-off and Bluetooth-off during discovery, connection, live writing and a non-destructive import. Errors must be visible; retries must preserve captured data.
8. Restart the server. Verify reconstruction and repeat-import deduplication, and that no orphan helper remains after shutdown. Check both Paper and editable projections.

See [Neo hardware notes](neo-linux-hardware.md) for protocol scope, live/offline ownership, paper calibration, controller limitations and provenance.
