# Third-party acknowledgements

InkRelay's proposed GPL-3.0-only licence covers its original source. Dependencies, fonts, vendor references and optional models retain their own terms. This is a source distribution: installed dependencies, compiled applications, font binaries, vendor documents and model weights are excluded.

## Protocol and paper references

Thanks to **NeoLAB Convergence, Inc.** for the public [Neo UWP SDK](https://github.com/NeoSmartpen/UWP-SDK), [Web SDK](https://github.com/NeoSmartpen/WEB-SDK2.0), and [Ncode documentation](https://github.com/NeoSmartpen/Documentations). These informed packet and paper-format interoperability. The SDKs publish GPLv3 texts; the UWP README also discusses non-commercial/commercial licensing. [The licensing review](docs/licensing.md) records this ambiguity and the conservative project choice. No vendor SDK binary, firmware, paper pattern, catalog or documentation PDF is included.

## Main application components

| Component | Purpose | Declared licence |
| --- | --- | --- |
| [Excalidraw](https://github.com/excalidraw/excalidraw) | Editable handwriting and diagrams | MIT; its fonts have separate terms |
| [React and React DOM](https://github.com/facebook/react) | Interface | MIT |
| [Fastify](https://github.com/fastify/fastify), CORS and static plugins | Local API and web server | MIT |
| [dbus-next](https://github.com/dbusjs/node-dbus-next) | Linux Bluetooth transport | MIT |
| [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) | Notebook definition parsing | MIT |
| [Zod](https://github.com/colinhacks/zod) | Input validation | MIT |
| [Undici](https://github.com/nodejs/undici) | HTTP connections | MIT |
| [Vite](https://github.com/vitejs/vite), [Vitest](https://github.com/vitest-dev/vitest), [TypeScript](https://github.com/microsoft/TypeScript), tsup and tsx | Development and builds | MIT, except TypeScript: Apache-2.0 |

The installed-package [inventory](licenses/npm-inventory.json) records exact versions, declared licences and missing notice files. [Collected npm notices](licenses/npm-notices.txt) preserve packaged copyright and licence texts, including transitive and build dependencies. The Excalidraw MIT text is also preserved [separately](licenses/excalidraw-LICENSE.txt), because its installed npm package does not include a licence file.

Regenerate after a frozen-lockfile install with `node scripts/collect-npm-notices.mjs`. This installation-specific list does not include every optional package for other operating systems. Some packages declare a licence without shipping its text; those entries remain explicitly marked for review before a bundled/binary release. An inventory is evidence, not a guarantee of licence compatibility for every possible distribution.

## Fonts

**Manrope**: Copyright 2019 The Manrope Project Authors. **Literata**: Copyright 2017 The Literata Project Authors. Both are SIL Open Font License 1.1, distributed through Fontsource. Their packaged full notices are in `licenses/npm-notices.txt`; a [full OFL notice](licenses/fontsource-OFL.txt) is provided separately as well.

Excalidraw 0.18.1 installs Assistant, Cascadia Code, Comic Shanns, Excalifont, Liberation Sans, Lilita One, Nunito, Virgil and Xiaolai. Their actual embedded copyright/licence records are collected in [font notices](licenses/excalidraw-font-notices.txt), including the Comic Shanns MIT text, Virgil OFL text and Cascadia's embedded terms. Regenerate with `node scripts/collect-font-notices.mjs`.

**Asset review remains necessary before redistributing compiled bundles.** Several font files contain incomplete or older licence metadata: Excalifont and Xiaolai omit a licence record, and Liberation refers to an external agreement. Cascadia contains both Microsoft product wording and an OFL-based grant. Do not assume Excalidraw's MIT licence applies to every font. Consult the upstream font sources and retain the applicable full notices before distributing font binaries. These binaries are not part of this source snapshot.

## Optional Python and model services

The language worker installs FastAPI (MIT), httpx (BSD-3-Clause), Pydantic (MIT), Pillow (HPND and bundled-component notices), Uvicorn (BSD-3-Clause), and their dependencies from `uv.lock`. The generic example has its own lockfile. These environments are not vendored; an executable or container release needs an inventory of the actual Python/system dependencies as well.

Docker images, Ollama, vLLM and separately downloaded models have their own licences. **Gemma weights use [Google's Gemma Terms](https://ai.google.dev/gemma/terms)**, not InkRelay's source licence. No model weights or provider credentials are included. See [the language-teacher guide](docs/language-teacher.md).

Product names acknowledge interoperability and do not imply endorsement by NeoLAB, LAMY, Moleskine, Obsidian, Excalidraw, Apple or Microsoft. Users' personal handwriting and exported documents are excluded from this source publication.
