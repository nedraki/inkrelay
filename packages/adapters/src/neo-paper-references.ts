import { createHash } from "node:crypto";
import type { PaperDefinition } from "@inkrelay/core";

// Product references measured in InkRelay, NOT official Neo metadata. Do not
// extend these to similar book codes or owners without a separate measurement.
const references = [
  { notebookId: "NEO_3_1012_3017", displayName: "LAMY 145 × 210 mm", widthMm: 145, heightMm: 210,
    transform: { scaleX: 2.391657897254377, scaleY: 2.4352730069213027, offsetX: -100.30134889505408, offsetY: -102.37118687516025 } },
  { notebookId: "NEO_3_27_701", displayName: "Moleskine 130 × 210 mm", widthMm: 130, heightMm: 210,
    transform: { scaleX: 2.393645958002394, scaleY: 2.3627432692905552, offsetX: -118.65955826351868, offsetY: -103.07778399552322 } },
  { notebookId: "NEO_3_27_747", displayName: "Neo 190 × 250 mm", widthMm: 190, heightMm: 250,
    transform: { scaleX: 2.3923444976076556, scaleY: 2.376892471451455, offsetX: -156.69856459330146, offsetY: -126.87438640004137 } }
] as const;

export const NEO_PAPER_REFERENCES: readonly PaperDefinition[] = references.map(({ notebookId, displayName, ...geometry }) => ({
  notebookId, displayName,
  provenance: { kind: "measured_reference", reference: "InkRelay two-cross product measurements, 2026-11-14; assumes uniform interior pages",
    digest: createHash("sha256").update(JSON.stringify(geometry)).digest("hex") },
  pages: [{ firstPage: 1, lastPage: 511, ...geometry }]
}));
