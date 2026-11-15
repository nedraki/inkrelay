import { posix } from "node:path";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

// Exact, visually reviewed demo captures and owner-approved shared images.
// Replacing bytes requires another privacy/metadata review, not a wildcard bypass.
const reviewedImages = new Map([
  ["docs/images/10-shared-excalidraw-editing.png", "f1cd9f9b5c5cfda57619696d100dd2c64f172d5f3e40dcb50cf3a63d77cb9882"],
  ["docs/images/09-shared-strokes-closeup.png", "c5f86ffce6e208f18939990c1f0ed6929b39fa620fe14c2e878239584f8f82ae"],
  ["docs/images/08-shared-real-strokes.png", "04fd6d4b11a489a1bac0e3e9224a1b4d0d78b5084dd25b2f82dadf94e20759d6"],
  ["docs/images/01-original.jpg", "57d51ef1cb2422c5cca726d94327ad179b345fcf1d7b5d16e908cb3737fadd46"],
  ["docs/images/02-get-notes.jpg", "ff4e9fa6f1d64700c542a6c41b3891c18719cc3c8172e98ca2c0b1615309510b"],
  ["docs/images/03-replay.jpg", "71755b9c78c50424cf91a70f5f880ca96f0ddc6d840f248f10d1bd2a30af69b4"],
  ["docs/images/04-editable-ink.jpg", "fd8e4c548310ba87712057fc6000095ad57ee6cec0e1904e73ef121ccf4dedc4"],
  ["docs/images/05-paper-setup.jpg", "8e75cebd7dd4129bc56b3860da3dac1b8099a497cec471db8b73864d40c3b25a"],
  ["docs/images/06-export-folder.jpg", "6dce3ebc48e924eb067cdfca00a48b9057c0b5f8ea5529456dce455cb96accb2"],
  ["docs/images/07-teacher.jpg", "788a4aa4a987c8b411d7e12ceccf00af7d8d970268f19e67421d43236cc19ac7"]
]);

export function isReviewedImage(path) { return reviewedImages.has(path); }

export function scanReviewedImage(path, input) {
  const bytes = Buffer.from(input);
  const findings = [];
  const expected = reviewedImages.get(path);
  if (!expected) return [{path, kind: "unreviewed-image"}];
  if (createHash("sha256").update(bytes).digest("hex") !== expected) findings.push({path, kind: "unreviewed-image-bytes"});
  if (path.endsWith(".png")) {
    try {
      if (!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error();
      let cursor=8, ended=false;
      while(cursor<bytes.length) {
        const length=bytes.readUInt32BE(cursor), kind=bytes.toString("ascii",cursor+4,cursor+8);
        if(cursor+length+12>bytes.length) throw new Error();
        if(!["IHDR","IDAT","IEND"].includes(kind)) findings.push({path,kind:"image-metadata"});
        cursor+=length+12;
        if(kind==="IEND") { ended=true; break; }
      }
      if(!ended || cursor!==bytes.length) throw new Error();
    } catch { findings.push({path,kind:"invalid-png"}); }
    return findings;
  }
  try {
    if (bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) throw new Error();
    let cursor = 2;
    while (cursor < bytes.length) {
      if (bytes[cursor++] !== 0xff) throw new Error();
      while (bytes[cursor] === 0xff) cursor++;
      const marker = bytes[cursor++];
      if (marker === 0xda || marker === 0xd9) break;
      const length = bytes.readUInt16BE(cursor);
      if (length < 2 || cursor + length > bytes.length) throw new Error();
      // Only the technical JFIF APP0 header is allowed. Reject EXIF, comments,
      // IPTC/XMP and other application metadata, even if a hash is approved.
      if (marker === 0xfe || (marker >= 0xe1 && marker <= 0xef)) findings.push({path, kind: "image-metadata"});
      cursor += length;
    }
  } catch { findings.push({path, kind: "invalid-jpeg"}); }
  return findings;
}

const rootFiles = new Set([".env.example", ".gitignore", ".gitattributes", "AGENTS.md", "README.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "CONTRIBUTING.md", "SECURITY.md", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "vitest.config.ts"]);
const fixtures = new Set(["fixtures/README.md", "fixtures/sample-session.events.jsonl", "fixtures/synthetic-paper.nproj", "fixtures/fake-bluetooth-helper.mjs"]);
const sourceExtension = /\.(?:ts|tsx|mts|mjs|js|py|md|json|yaml|yml|toml|lock|html|css|swift|plist|sh|txt)$/;

/** Deliberately narrower than .gitignore. Unknown files require human review. */
export function isPublicSource(path) {
  if (!path || path.includes("\\") || path.startsWith("/") || path.split("/").includes("..")) return false;
  if (/(?:^|\/)(?:\.git|node_modules|dist|\.build|\.venv|__pycache__|\.pytest_cache|tmp|\.obsidian|\.publication-review|notes|vaults?|notebooks|captures|recordings|screenshots|publication|models|raw|workflow|language-reviews)(?:\/|$)/.test(path)) return false;
  if (fixtures.has(path)) return true;
  if (isReviewedImage(path)) return true;
  if (/\.(?:jsonl|nproj|excalidraw|sqlite\w*|db|png|jpe?g|pdf|zip|pem|key)$/i.test(path)) return false;
  if (/^(?:paper-profiles|paper-definitions|notebook-instances|settings)\.json$/.test(posix.basename(path))) return false;
  if (/^(?:credentials|service-account).*\.json$/i.test(posix.basename(path))) return false;
  if (rootFiles.has(path)) return true;
  if (/^infra\/compose\/(?:README\.md|language(?:\.(?:nvidia|amd|forwarded))?\.yml)$/.test(path)) return true;
  if (/^config\/language\/[a-z-]+\.env\.example$/.test(path)) return true;
  if (!/^(?:apps|packages|services|examples|docs|config|native\/macos|scripts|skills|tests|licenses|\.github)\//.test(path)) return false;
  if (/^(?:services|examples)\/[a-z-]+\/(?:Dockerfile|\.dockerignore)$/.test(path)) return true;
  return sourceExtension.test(path) || /^licenses\/[^/]+\/[^/]*(?:LICENSE|NOTICE|COPYING)(?:\.[a-z]+)?$/i.test(path);
}

const secretPatterns = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["service-token", /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{18,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16})\b/],
  ["url-credentials", /https?:\/\/[^\s/:@]+:[^\s/@]+@/],
  ["home-directory", /\/(?:Users|home)\/(?!user(?:\/|\b)|you(?:\/|\b)|example(?:\/|\b))[^\s/"'`]+\//],
  ["personal-capture-id", /\b(?:live|offline)-[0-9a-f]{12}-\d{8,}/i],
  ["captured-notebook-instance", /\bnotebook_[0-9a-f]{8}-[0-9a-f-]{27,}\b/i]
];

export function scanPublicText(path, text, privateMarkers = []) {
  const findings = [];
  if (text.includes("\u0000")) findings.push({path, kind: "binary-content"});
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    for (const [kind, pattern] of secretPatterns) if (pattern.test(line)) findings.push({path, line: index + 1, kind});
    for (const marker of privateMarkers) if (marker.length >= 4 && line.toLowerCase().includes(marker.toLowerCase())) {
      findings.push({path, line: index + 1, kind: "private-marker"});
      break;
    }
  }
  if (path === "fixtures/sample-session.events.jsonl") {
    try {
      const events = text.trim().split(/\r?\n/).map(line => JSON.parse(line));
      if (events.length !== 15 || events.some(e => e.source !== "mock" || e.penId !== "demo-pen" || e.sessionId !== "demo-session-v1" || e.notebookId !== "NB01")) throw new Error();
    } catch { findings.push({path, kind: "non-synthetic-event-fixture"}); }
  }
  if (path === "fixtures/synthetic-paper.nproj" && (!text.includes("<code>8000</code>") || !text.includes("Synthetic"))) findings.push({path, kind: "unverified-paper-fixture"});
  return findings;
}
