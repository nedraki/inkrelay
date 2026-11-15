# Preparing a private-data-free source publication

The owner reviews and approves the prepared files before anyone creates a GitHub repository or pushes code. Preparation commands below do neither. This guide is for maintainers; users installing InkRelay should start with the README.

## Use a fresh source snapshot

An ignore file protects future additions; it does not remove files or identities from old commits. Do not publish an existing development checkout's history merely because its current tree looks clean. Keep the original checkout and personal data intact, and use a new history-free source snapshot for first publication.

Run from the original checkout:

```bash
pnpm publication:check
pnpm publication:prepare
```

The default output is the ignored `.publication-review/source` directory. It must not already exist. Use `node scripts/prepare-publication.mjs --output .publication-review/source-v2` for another revision; the tool never overwrites or cleans an existing directory.

The exporter reads Git's tracked/unignored file list, permits only reviewed source locations/extensions and explicit synthetic fixtures, rejects symlinks, and scans for common credentials, personal home paths and captured identifiers. Unknown files and ignored-but-still-tracked private files block export. It excludes `.git`, installed packages, native builds, real event corpora, environment settings, notebook metadata, vaults, captures, personal documents/screenshots, model weights and local review reports.

Ten README images are individually approved exceptions. Seven show a separate synthetic demo and three are the specific real-doodle/editing screenshots selected by the owner, with provenance in `docs/images/README.md`. Their exact SHA-256 hashes are pinned in the publication policy, and JPEG metadata is checked. Changed bytes fail export until deliberately reviewed again; other images remain ignored. An offer to share personal screenshots does not authorize capturing or publishing unrelated notes.

You can add known private names, device IDs or email addresses to `.publication-review/private-markers.json` as a JSON string array. This local file is ignored and never exported. Findings report only file/line and category, not matched secret text. The ignored `.publication-review/audit.json` records the result.

`PUBLICATION_MANIFEST.json` inside the snapshot lists each copied file's byte length and SHA-256. Nothing is committed, no Git identity is copied, and no remote is contacted by the exporter. It is a review aid, not a proof that arbitrary prose cannot contain sensitive information.

## Review the exact output

- Read every file on the manifest, especially prose, tests, comments, fixtures and third-party notices. Confirm examples are invented and contain no personal handwriting or notebook names.
- Confirm the snapshot has no `.git`, real `.env`, `tmp/`, notes, vault, personal screenshots, model weights or build output. Review the ten approved illustrations too. Keep local reports and markers outside the publication.
- Confirm the licence and public attribution in `LICENSE`, `NOTICE`, [licensing review](licensing.md) and `THIRD_PARTY_NOTICES.md`. GPL-3.0-only is the proposed source licence; Neo provenance/wording and font-bundle limitations are documented there.
- Validate installation, tests and builds from the snapshot in a separate location, using only synthetic data and disabled Bluetooth. Keep any generated dependencies and test output ignored. Never load the owner's `.env` or personal vault to test publication.
- Check the manifest again after validation. A source edit requires a new export and another review. No actual notes are needed to demonstrate the product; use synthetic fixtures for future screenshots and issues.

The `.gitignore` is intentionally conservative: it ignores images and common exported documents except the ten named README illustrations. New public artwork or fixtures need deliberate review and a corresponding publication-policy change; do not bypass this with a broad force-add or wildcard exception.

## After explicit owner approval only

Confirm the intended GitHub account, repository name/visibility, licence decision and a public Git author identity. Start a **new local Git repository in the reviewed snapshot**, with no original history, branches, tags or remotes. Stage only the reviewed manifest files and the manifest itself; inspect the staged diff and staged paths for unexpected generated/private material before committing.

Create the GitHub repository and push only once the owner has authorized those actions. Do not add a remote to the private development repository, mirror it, or push its existing branches/tags. Keep the original notes and configuration local. Enabling a public repository is the point at which source and its licence become available to others, so pending licence/privacy decisions must be settled first.

For later contributions, run the privacy check before commits and review staged changes. A history-free first release does not prevent future accidental disclosure. Do not upload private examples to issues or CI, and never use real Bluetooth hardware or a live model in automated tests.
