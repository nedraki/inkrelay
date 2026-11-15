# Licensing and attribution review

Review date: 2026-11-14. This records evidence and a proposed release decision; it is not a warranty of legal clearance. The owner must confirm the choice before publication.

## Proposed project licence: GPL-3.0-only

`LICENSE` contains the unmodified GPLv3 text from the [SPDX licence list](https://github.com/spdx/license-list-data/blob/main/text/GPL-3.0-only.txt). Root and internal JavaScript package metadata use `GPL-3.0-only`. `NOTICE` identifies InkRelay contributors without exposing a private personal name or email. Python source and setup documentation are part of the same repository licence; separately downloaded dependencies retain their own terms.

GPLv3 permits use, modification and redistribution, including commercial activity, subject to its conditions. Source redistribution must retain copyright/licence notices. Distributing a combined executable may require complete corresponding source, build/install information and applicable notices. The licence has no general non-commercial restriction. See [GPLv3 terms](https://spdx.org/licenses/GPL-3.0-only.html). This is a conservative project choice, not a claim that reading protocol facts by itself automatically requires GPL.

The owner's notes, physical-notebook metadata, API keys, exports, screenshots and model weights are not part of the licensed source publication. No rights in them are granted by the project licence.

## Neo references: preserve credit and do not overclaim clearance

The repository's development record identifies public NeoLAB UWP SDK packet information as a protocol reference. The metadata parser was written against published Nproj examples and the Web SDK's coordinate/margin behavior. This was not documented as an isolated clean-room implementation, so the conservative draft retains GPLv3 and credits NeoLAB rather than asserting unrestricted MIT licensing.

| Reference | Evidence | Relevance |
| --- | --- | --- |
| [Neo UWP SDK](https://github.com/NeoSmartpen/UWP-SDK) | [LICENSE](https://github.com/NeoSmartpen/UWP-SDK/blob/master/LICENSE) is standard GPLv3; [README licence section](https://github.com/NeoSmartpen/UWP-SDK#license) separately describes non-commercial GPL use and a commercial licence. | Command identifiers, framing, UUIDs and packet layouts consulted during development. |
| [Neo Web SDK](https://github.com/NeoSmartpen/WEB-SDK2.0) | [LICENSE.txt](https://github.com/NeoSmartpen/WEB-SDK2.0/blob/master/LICENSE.txt) is GPLv3; the current README labels GPL-3.0-only. | Offline-transfer behavior and [paper metadata conversion](https://github.com/NeoSmartpen/WEB-SDK2.0/blob/master/src/API/NoteServer.ts). |
| [Ncode documentation](https://github.com/NeoSmartpen/Documentations) | Public technical documents; public availability is not a blanket redistribution grant. | Identity fields, coordinate units and Nproj geometry. The documents/PDFs themselves are not repackaged here. |

**Unresolved upstream wording:** the UWP README's non-commercial/commercial framing and its standard GPLv3 licence file do not describe the same simple permission boundary. Do not invent a “non-commercial GPL” for InkRelay, remove the vendor credit, or promise that proprietary/commercial redistribution of reference-derived material is cleared. Before a commercial/proprietary release, resolve provenance and applicable rights with the rightsholder or qualified counsel. Choosing GPLv3 and retaining notices is a conservative preparation step, not a way to override additional rights or cure an unknown provenance problem.

There is no `web_pen_sdk`, Neo UWP binary, vendor firmware, licensed paper PDF or official Nproj catalog bundled with the source. The synthetic Nproj fixture is invented test data. The three measured paper definitions contain generic product geometry and no pen serial number, physical-copy name, captured stroke or personal writing. Ncode generation/pattern rights are outside this project's source licence.

## Third-party dependencies and fonts

[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) names the main components. The generated inventory and collected licence texts under `licenses/` cover the dependency packages installed for this review, including development/build dependencies. They are not a statement that dependencies have been relicensed under GPL.

The inventory is installation/platform-specific: optional packages for other platforms may not be installed here. It includes explicit resolutions where old package metadata omits a licence but the installed licence file supplies one. Packages lacking a packaged notice are marked rather than silently treated as cleared. The source-only publication snapshot excludes installed dependencies and compiled bundles. Before shipping an executable/container/web bundle, regenerate the inventory for that artifact, preserve its dependencies' notices and verify separately loaded fonts/assets. The generated npm notice collection is not a substitute for that artifact review.

The UI includes Manrope and Literata (SIL OFL 1.1) and Excalidraw, which supplies additional font families under separate font licences. Actual copyright/licence records were extracted from all installed Excalidraw WOFF2 assets into `licenses/excalidraw-font-notices.txt`. Some records are incomplete or contain older wording; the outstanding asset checks are listed in `THIRD_PARTY_NOTICES.md`. Font notices must accompany redistributed font files. The package licence alone is not enough to establish every bundled asset's rights.

Python dependency and Docker image licences remain applicable when installed. The language worker uses FastAPI, httpx, Pydantic, Pillow and Uvicorn; its `uv.lock` pins the source environment. Debian/system libraries in container images carry their own notices. No container image or Python environment is included in this source snapshot.

## Models and external products

The optional Ollama runtime and the selected model are different components. Gemma 3 is governed by [Google's Gemma Terms](https://ai.google.dev/gemma/terms), not InkRelay's GPL. Users download weights separately into their Docker volume; no weights or model-service credentials are published here. Model/provider terms must be reviewed for the selected deployment. Do not label all optional models as OSI open source or assume an application's licence covers them.

NeoLAB, LAMY, Moleskine, Obsidian, Apple and Microsoft product names are used for identification. No endorsement or right to use logos/marks beyond applicable law is claimed. Obsidian itself, Apple frameworks and vendor applications are not part of the source distribution.

## Owner review before publication

- Confirm the GPL-3.0-only choice and public credit in `NOTICE`; choose a public Git author identity (for example a GitHub noreply address) when creating the fresh repository.
- Review the Neo provenance/wording issue above; this review does not guarantee rights in unknown copied code or proprietary materials.
- Publish only the reviewed source snapshot; do not push the original development history, private notes or local review reports.
- Do not release compiled application bundles, containers, models or font collections under the assumption that this source-only review covers them.
