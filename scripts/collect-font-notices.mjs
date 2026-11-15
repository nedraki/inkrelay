// Extract copyright and licence name-table records from installed WOFF2 assets.
// No font binaries are copied. WOFF2 table directory: https://www.w3.org/TR/WOFF2/
import { brotliDecompressSync } from "node:zlib";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const tags = "cmap head hhea hmtx maxp name OS/2 post cvt_ fpgm glyf loca prep CFF_ VORG EBDT EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG_ sbix acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill".split(" ");
function metadata(bytes) {
  if (bytes.toString("ascii", 0, 4) !== "wOF2" || bytes.toString("ascii", 4, 8) === "ttcf") throw new Error("Expected single-font WOFF2");
  let cursor = 48;
  const base128 = () => {
    let result = 0;
    for (let i = 0; i < 5; i++) {
      const value = bytes[cursor++];
      if (value === undefined || (i === 0 && value === 0x80)) throw new Error("Invalid WOFF2 integer");
      result = result * 128 + (value & 127);
      if (!(value & 128)) return result;
    }
    throw new Error("Oversized WOFF2 integer");
  };
  let offset = 0;
  let name;
  for (let index = 0; index < bytes.readUInt16BE(12); index++) {
    const flags = bytes[cursor++];
    const tagIndex = flags & 63;
    const tag = tagIndex === 63 ? bytes.toString("ascii", cursor, cursor += 4) : tags[tagIndex];
    const originalLength = base128();
    const transformed = ["glyf", "loca"].includes(tag) ? flags >> 6 !== 3 : flags >> 6 !== 0;
    const storedLength = transformed ? base128() : originalLength;
    if (tag === "name") {
      if (transformed) throw new Error("Unsupported transformed name table");
      name = {offset, length: storedLength};
    }
    offset += storedLength;
  }
  const stream = brotliDecompressSync(bytes.subarray(cursor, cursor + bytes.readUInt32BE(20)));
  if (stream.length !== offset || !name) throw new Error("Invalid WOFF2 table stream");
  const table = stream.subarray(name.offset, name.offset + name.length);
  const records = [];
  const strings = table.readUInt16BE(4);
  for (let index = 0; index < table.readUInt16BE(2); index++) {
    const record = 6 + index * 12;
    const platform = table.readUInt16BE(record);
    const id = table.readUInt16BE(record + 6);
    if (![0, 1, 13, 14].includes(id)) continue;
    const start = strings + table.readUInt16BE(record + 10);
    const data = Buffer.from(table.subarray(start, start + table.readUInt16BE(record + 8)));
    const text = [0, 3].includes(platform) ? data.swap16().toString("utf16le") : data.toString("latin1");
    if (!records.some(value => value.id === id && value.text === text)) records.push({id, text});
  }
  return records;
}
async function fonts(directory) {
  const paths = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await fonts(path));
    else if (entry.name.endsWith(".woff2")) paths.push(path);
  }
  return paths.sort();
}
const assets = resolve(root, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");
const families = new Map();
for (const path of await fonts(assets)) {
  const family = relative(assets, path).split("/")[0];
  const records = families.get(family) ?? [];
  for (const record of metadata(await readFile(path))) if (!records.some(value => value.id === record.id && value.text === record.text)) records.push(record);
  families.set(family, records);
}
const output = ["Excalidraw 0.18.1 font asset notices", "Copyright, family, licence and licence-URL records extracted from installed WOFF2 name tables.", "No font files are redistributed in this source snapshot. Preserve these records and the applicable full licence when redistributing fonts.", ""];
for (const [family, records] of [...families].sort(([a], [b]) => a.localeCompare(b))) {
  output.push("=".repeat(72), family);
  for (const record of records) output.push(`[name ID ${record.id}]`, record.text.trim());
  output.push("");
}
await mkdir(resolve(root, "licenses"), {recursive: true});
await writeFile(resolve(root, "licenses/excalidraw-font-notices.txt"), output.join("\n") + "\n");
console.log(JSON.stringify({families: [...families.keys()].sort()}, null, 2));
