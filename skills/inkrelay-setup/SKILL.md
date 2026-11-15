---
name: inkrelay-setup
description: Install, start, update, or troubleshoot InkRelay on a user's own computer, including macOS/Linux pen capture and optional language-teacher setup. Use for operating the product, not changing its source or publishing repositories.
---

# Set up InkRelay for its owner

Work from this repository's root. Read [README](../../README.md) and the relevant sections of [development](../../docs/development.md). Explain decisions in ordinary language; the owner may not be a programmer.

## Establish a safe starting point

- Detect the actual host OS, Node and pnpm versions. A remote Linux container cannot use the host Mac's Bluetooth. Ask only for missing hardware or workflow information.
- Inspect whether `.env`, `tmp/inkrelay-data`, a saved settings file or a configured vault already exists. Preserve them. Never print whole environment files, credentials or notebook contents in chat or logs.
- Keep the server on `127.0.0.1`. Installation does not authorize exposing ports, uploading notes, configuring a remote model, changing a vault, deleting data, or publishing the repository.
- Confirm whether an existing InkRelay process is running before starting another. Avoid stopping another project on the same port.

## Install and start core capture

1. Use Node 22.19+ and the repository's pinned pnpm 10.10.0. Install dependencies with `pnpm install --frozen-lockfile`. Follow the installed package manager's documented build approval flow if it reports blocked scripts; approve only the needed known dependencies, not every script globally.
2. If `.env` is absent, copy `.env.example`. If it exists, keep it and change only the settings needed for the chosen task. Defaults keep capture and exports under ignored `tmp/` folders.
3. On macOS 12+, follow [macOS hardware setup](../../docs/macos-hardware.md). Apple Command Line Tools are needed; the native helper builds automatically in `pnpm build` or `pnpm dev:server`. Let the owner handle Apple's installer, licence agreements and unexpected permission prompts. Explain any Bluetooth consent request.
4. On Linux, follow [Linux hardware setup](../../docs/neo-linux-hardware.md). Use the logged-in user's BlueZ/D-Bus access; do not run the whole server as root.
5. On Windows, explain that native pen capture is not implemented. Set Bluetooth disabled for an agreed UI/replay-only exploration. Do not suggest Docker will provide macOS/Windows host Bluetooth.
6. Run `pnpm build`, then `pnpm start`. Verify `/api/health` and show `http://127.0.0.1:4317`. `pnpm dev` is an alternative with the UI on 4318. Do not claim pen compatibility merely because the page opens.

For a no-pen trial, use Bluetooth disabled and separate ignored demo paths for raw events, paper profiles, notebook assignments and the export vault. Load only `fixtures/sample-session.events.jsonl`. Do not run a demo against an existing capture corpus or personal vault.

## Verify the owner's workflow

- Ask the owner to wake the compatible pen and disconnect other pen apps. Scan and connect, then read model/status. Do not guess a pen password.
- Before importing, check the intended physical notebook if copies reuse paper identities. Import only when requested. Transfers retain pen data; do not add deletion or firmware commands.
- If requested, test a short disposable live sample and page switch. Explain that live writing may not also enter the pen's offline memory. Use disconnected writing followed by import for the dual-app path.
- Paper metadata is incomplete: exact measured references may work automatically, but `.nproj` files are not generally supplied to consumers. Do not promise a downloadable catalog. Keep existing manual calibrations authoritative and offer the manual fallback when needed.
- Explain Original, Editable ink, Diagram and Teacher notes. Browser Excalidraw edits are only a local convenience cache, not server-backed or part of Obsidian export.

Finish with the actual tested state, any remaining hardware checks, how to start/stop the app, and the exact local data/export locations. `tmp/inkrelay-data` is persistent writing despite its name; recommend backups. No screenshots of personal writing are needed for setup.

## Optional language teacher

Only after the owner chooses it, follow [language-teacher setup](../../docs/language-teacher.md). Python uses `uv` and the committed lock; local model weights use Docker's named volume. Explain downloads, resource needs, model terms and whether the selected endpoint is local, LAN or cloud. Obtain agreement before sending a real page to a remote service. Python returns results; TypeScript owns vault writes.

## Updates and recovery

Back up the capture directory, notebook/paper metadata and chosen vault first. Preserve `.env` and `.env.language`; rebuild source separately from personal data. Retry interrupted imports rather than clearing logs. Never use debug-clear, pen-memory deletion, firmware updates or removal of `tmp/` as installation repair. Describe failures accurately and use synthetic reproductions for public reports.
