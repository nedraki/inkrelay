import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPublicSource, scanPublicText, isReviewedImage, scanReviewedImage } from "./publication-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
let checkOnly = false;
let outputArgument;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--check" && !checkOnly) checkOnly = true;
  else if (arg === "--output" && outputArgument === undefined && args[index + 1] && !args[index + 1].startsWith("--")) outputArgument = args[++index];
  else throw new Error("Usage: node scripts/prepare-publication.mjs [--check] [--output NEW_DIRECTORY]");
}
const output = resolve(root, outputArgument ?? ".publication-review/source");
if (output === root || root.startsWith(output + "/")) throw new Error("Publication output cannot contain or replace the working repository");

const git = (...command) => execFileSync("git", ["-C", root, ...command], {encoding: "utf8", maxBuffer: 20_000_000});
let candidates;
try { candidates = git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean); }
catch { throw new Error("Run the exporter from the original development checkout; do not initialize or publish the snapshot automatically"); }
const deleted = new Set(git("ls-files", "--deleted", "-z").split("\0").filter(Boolean));
candidates = [...new Set(candidates)].filter(path => !deleted.has(path)).sort();
const tracked = new Set(git("ls-files", "-z").split("\0").filter(Boolean));
// A local marker list can name sensitive identifiers without putting them into
// shared scanner source. This file is ignored and is never copied to output.
let markers = [];
try { markers = JSON.parse(await readFile(resolve(root, ".publication-review/private-markers.json"), "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (!Array.isArray(markers) || markers.some(marker => typeof marker !== "string")) throw new Error("Private markers must be a string array");

const files = [];
const findings = [];
for (const path of candidates) {
  if (!isPublicSource(path)) { findings.push({path, kind: tracked.has(path) ? "tracked-file-not-approved" : "unreviewed-file"}); continue; }
  const fullPath = resolve(root, path);
  const metadata = await lstat(fullPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) { findings.push({path, kind: "not-a-regular-file"}); continue; }
  const bytes = await readFile(fullPath);
  if (isReviewedImage(path)) findings.push(...scanReviewedImage(path, bytes));
  else {
    const text = new TextDecoder("utf-8", {fatal: true});
    try { findings.push(...scanPublicText(path, text.decode(bytes), markers)); }
    catch { findings.push({path, kind: "invalid-utf8"}); }
  }
  files.push({path, bytes, sha256: createHash("sha256").update(bytes).digest("hex")});
}
const report = {
  schemaVersion: "inkrelay.publication_audit.v1", checkedFiles: files.length, findings,
  localHistoryCommits: Number(git("rev-list", "--all", "--count").trim()),
  historyAndGitIdentityExcluded: true, remoteConfigured: Boolean(git("remote").trim()),
  note: "Pattern checks are not a guarantee of privacy or licence clearance; inspect the complete source manifest before publishing."
};
await mkdir(resolve(root, ".publication-review"), {recursive: true});
await writeFile(resolve(root, ".publication-review/audit.json"), JSON.stringify(report, null, 2) + "\n");
if (findings.length) { console.error(JSON.stringify(report, null, 2)); process.exitCode = 1; }
else if (checkOnly) console.log(JSON.stringify(report, null, 2));
else {
  try { await lstat(output); throw new Error("Output already exists; choose a new directory so no review files or notes are overwritten"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(output, {recursive: true});
  for (const file of files) {
    const target = resolve(output, file.path);
    await mkdir(dirname(target), {recursive: true});
    await writeFile(target, file.bytes, {flag: "wx"});
    await chmod(target, file.path.endsWith(".sh") ? 0o755 : 0o644);
  }
  const manifest = {
    schemaVersion: "inkrelay.publication_manifest.v1", historyIncluded: false,
    files: files.map(file => ({path: file.path, bytes: file.bytes.length, sha256: file.sha256}))
  };
  await writeFile(resolve(output, "PUBLICATION_MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n", {flag: "wx"});
  console.log(JSON.stringify({files: files.length, output: relative(root, output), historyIncluded: false, repositoryCreated: false, pushed: false}, null, 2));
}
