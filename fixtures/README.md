# Synthetic fixtures only

These files are artificial inputs for tests and demonstrations. They contain no personal handwriting, actual pen serial numbers, real physical-notebook names or captured Bluetooth traffic.

- `sample-session.events.jsonl`: fifteen hand-authored mock dots, fake pen/session IDs and a fixed demonstration date; the geometry exercises ink and paper action zones.
- `synthetic-paper.nproj`: invented paper identity and deliberately asymmetric geometry for metadata parsing tests; not a vendor notebook definition.
- `fake-bluetooth-helper.mjs`: synthetic IPC peer; never touches Bluetooth hardware.

Do not replace these with personal pen downloads. Capture files and imported metadata are ignored by Git; publishing a new fixture requires constructing a minimal synthetic example. The publication checker only allows the named JSONL/NPROJ fixtures and validates their synthetic identities.
