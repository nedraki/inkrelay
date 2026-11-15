// Run after a frozen-lockfile install. Collect text notices, never package code
// or fonts. This is an installed-platform inventory, not a licence verdict.
import { readdir, readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packages = new Map();
const visited = new Set();
async function inspectModules(directory) {
  let entries;
  try { entries = await readdir(directory, {withFileTypes: true}); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return; throw error; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const path = resolve(directory, entry.name);
    if (entry.name.startsWith("@")) { await inspectModules(path); continue; }
    const actual = await realpath(path);
    if (visited.has(actual)) continue;
    visited.add(actual);
    let pkg;
    try { pkg = JSON.parse(await readFile(resolve(actual, "package.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!pkg.name || !pkg.version || pkg.name.startsWith("@inkrelay/")) continue;
    packages.set(`${pkg.name}@${pkg.version}`, {pkg, path: actual});
    await inspectModules(resolve(actual, "node_modules"));
  }
}
await inspectModules(resolve(root, "node_modules"));
for (const entry of await readdir(resolve(root, "node_modules/.pnpm"))) {
  if (entry !== "node_modules") await inspectModules(resolve(root, "node_modules/.pnpm", entry, "node_modules"));
}

async function notices(directory, base = directory) {
  const result = [];
  for (const entry of (await readdir(directory, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "node_modules" || entry.isSymbolicLink()) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await notices(path, base));
    else if (/^(?:licen[cs]e|notice|copying|ofl|copyright)(?:[._-].*)?$/i.test(entry.name)) {
      const bytes = await readFile(path);
      if (bytes.length > 1_000_000 || bytes.includes(0)) continue;
      result.push({file: relative(base, path), text: bytes.toString("utf8")});
    }
  }
  return result;
}
// Explicit resolutions cite the packaged text when legacy metadata is absent.
const resolved = new Map([["jsbi@2.0.5", "Apache-2.0"], ["khroma@2.1.0", "MIT"], ["map-stream@0.1.0", "MIT"]]);
const inventory = [];
const output = ["Installed npm dependency notices for InkRelay", "Generated from a frozen-lockfile installation. Platform-specific optional packages may be absent.", "Dependencies retain their own licences. This collection does not relicense them.", ""];
for (const [key, {pkg, path}] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const texts = await notices(path);
  const declared = pkg.license ?? pkg.licenses ?? null;
  const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url ?? null;
  inventory.push({name: pkg.name, version: pkg.version, declaredLicense: declared, ...(resolved.has(key) ? {reviewedLicense: resolved.get(key), evidence: "Packaged licence text below"} : {}), repository, noticeFiles: texts.map(t => t.file), ...(texts.length ? {} : {review: "No packaged licence/notice text found; inspect upstream before binary redistribution"})});
  output.push("=".repeat(72), key, `Declared licence: ${JSON.stringify(declared)}`, ...(resolved.has(key) ? [`Reviewed licence: ${resolved.get(key)} (packaged text)`] : []), `Repository: ${repository ?? "not specified"}`);
  for (const notice of texts) output.push(`--- ${notice.file} ---`, notice.text.trim());
  if (!texts.length) output.push("No packaged licence/notice text found; see inventory review field.");
  output.push("");
}
await mkdir(resolve(root, "licenses"), {recursive: true});
await writeFile(resolve(root, "licenses/npm-inventory.json"), JSON.stringify({schemaVersion: "inkrelay.npm_notices.v1", scope: "Installed packages, including development dependencies; no local paths or package binaries", packages: inventory}, null, 2) + "\n");
await writeFile(resolve(root, "licenses/npm-notices.txt"), output.join("\n") + "\n");
console.log(JSON.stringify({packages: inventory.length, withoutPackagedNotice: inventory.filter(p => p.review).map(p => `${p.name}@${p.version}`)}, null, 2));
