import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPublicSource, scanPublicText, scanReviewedImage } from "../scripts/publication-policy.mjs";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, {recursive: true, force: true}); });

describe("source publication privacy", () => {
  it("allows source and synthetic fixtures while excluding personal data", () => {
    for (const path of ["README.md", "apps/web/src/main.tsx", "native/macos/Info.plist", "services/language-worker/Dockerfile", "fixtures/sample-session.events.jsonl"]) expect(isPublicSource(path)).toBe(true);
    for (const path of [".env", ".env.language", ".git/config", "tmp/inkrelay-data/raw/private.events.jsonl", "notes/private.md", "apps/web/notes/private.md", "apps/web/notes.jsonl", "config/settings.json", "config/credentials-local.json", "fixtures/my-notebook.nproj", "apps/web/dist/index.html", "screenshots/page.png", "../README.md"]) expect(isPublicSource(path)).toBe(false);
  });

  it("reports secrets and configured private markers without repeating their contents", () => {
    const token = ["gh", "p_", "x".repeat(30)].join("");
    const home = ["/Users", "private-owner", "notebooks"].join("/") + "/";
    const findings = scanPublicText("docs/example.md", `${token}\n${home}\nprivate notebook name`, ["private notebook name"]);
    expect(findings.map(f => f.kind)).toEqual(["service-token", "home-directory", "private-marker"]);
    expect(JSON.stringify(findings)).not.toContain(token);
    expect(scanPublicText("fixtures/sample-session.events.jsonl", '{"source":"neo"}')).toEqual([{path: "fixtures/sample-session.events.jsonl", kind: "non-synthetic-event-fixture"}]);
  });

  it("accepts only the exact reviewed image bytes and rejects hidden metadata", async () => {
    expect(scanReviewedImage("docs/images/09-shared-strokes-closeup.png", await readFile("docs/images/09-shared-strokes-closeup.png"))).toEqual([]);
    expect(scanReviewedImage("docs/images/10-shared-excalidraw-editing.png", await readFile("docs/images/10-shared-excalidraw-editing.png"))).toEqual([]);
    const pngPath = "docs/images/08-shared-real-strokes.png";
    const png = await readFile(pngPath);
    expect(scanReviewedImage(pngPath, png)).toEqual([]);
    expect(scanReviewedImage(pngPath, Buffer.concat([png, Buffer.from("changed")])).map(f => f.kind)).toContain("unreviewed-image-bytes");
    const path = "docs/images/01-original.jpg";
    const bytes = await readFile(path);
    expect(isPublicSource(path)).toBe(true);
    expect(isPublicSource("docs/images/private-notes.jpg")).toBe(false);
    expect(scanReviewedImage(path, bytes)).toEqual([]);
    expect(scanReviewedImage("docs/images/private-notes.jpg", bytes)).toEqual([{path: "docs/images/private-notes.jpg", kind: "unreviewed-image"}]);
    const changed = Buffer.concat([bytes, Buffer.from("changed")]);
    expect(scanReviewedImage(path, changed).map(f => f.kind)).toContain("unreviewed-image-bytes");
    const metadata = Buffer.from([0xff, 0xe1, 0, 4, 0, 0]);
    const withMetadata = Buffer.concat([bytes.subarray(0, 2), metadata, bytes.subarray(2)]);
    expect(scanReviewedImage(path, withMetadata).map(f => f.kind)).toContain("image-metadata");
  });

  it("exports without history or ignored notes and refuses unknown files, symlinks and overwrites", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "inkrelay-publication-"));
    directories.push(root);
    await mkdir(resolve(root, "scripts"));
    for (const file of ["prepare-publication.mjs", "publication-policy.mjs"]) await copyFile(resolve("scripts", file), resolve(root, "scripts", file));
    await copyFile(resolve(".gitignore"), resolve(root, ".gitignore"));
    await mkdir(resolve(root, "docs/images"), {recursive: true});
    const imagePath = "docs/images/01-original.jpg";
    await copyFile(resolve(imagePath), resolve(root, imagePath));
    await writeFile(resolve(root, "README.md"), "Synthetic public source\n");
    await writeFile(resolve(root, ".env"), "PRIVATE_TEST_SETTING=keep\n");
    await mkdir(resolve(root, "tmp"));
    await writeFile(resolve(root, "tmp", "private.md"), "Synthetic private note\n");
    execFileSync("git", ["init", "--quiet", root]);
    const run = (...args: string[]) => spawnSync(process.execPath, [resolve(root, "scripts/prepare-publication.mjs"), ...args], {cwd: root, encoding: "utf8"});
    expect(run("--unknown").status).not.toBe(0);
    expect(run("--output").status).not.toBe(0);
    expect(run().status).toBe(0);
    const output = resolve(root, ".publication-review/source");
    expect(await readdir(output)).toEqual(expect.arrayContaining(["README.md", "PUBLICATION_MANIFEST.json", "scripts"]));
    expect(await readdir(output)).not.toEqual(expect.arrayContaining([".git"]));
    expect(await readdir(output)).not.toContain(".env");
    expect(await readdir(output)).not.toContain("tmp");
    expect(await readFile(resolve(root, "tmp/private.md"), "utf8")).toBe("Synthetic private note\n");
    expect(await readFile(resolve(output, imagePath))).toEqual(await readFile(resolve(imagePath)));
    const manifest = JSON.parse(await readFile(resolve(output, "PUBLICATION_MANIFEST.json"), "utf8"));
    expect(manifest.historyIncluded).toBe(false);
    expect(manifest.files.find((f: {path: string}) => f.path === "README.md").sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(run().status).not.toBe(0);
    await writeFile(resolve(root, imagePath), "Unreviewed replacement image");
    expect(run("--check").status).not.toBe(0);
    await copyFile(resolve(imagePath), resolve(root, imagePath));
    await writeFile(resolve(root, "unreviewed.md"), "Review me\n");
    expect(run("--check").status).not.toBe(0);
    await rm(resolve(root, "unreviewed.md"));
    await symlink(resolve(root, ".env"), resolve(root, "scripts/linked.ts"));
    expect(run("--check").status).not.toBe(0);
    await rm(resolve(root, "scripts/linked.ts"));
    execFileSync("git", ["-C", root, "add", "-f", ".env"]);
    expect(run("--check").status).not.toBe(0);
  });
});
