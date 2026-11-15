import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";

const SETTINGS_SCHEMA_VERSION = "inkrelay.settings.v1" as const;

export type AppSettings = {
  readonly vaultPath: string;
  readonly source: "configured" | "saved";
  readonly warning?: string;
};

export class AppSettingsStore {
  constructor(private readonly path: string, private readonly configuredVaultPath: string) {}

  async load(): Promise<AppSettings> {
    try {
      const input = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!isSettingsFile(input)) throw new Error(`Invalid InkRelay settings file: ${this.path}`);
      return this.describe(input.obsidianVaultPath, "saved");
    } catch (error) {
      if (isMissing(error)) return this.describe(this.configuredVaultPath, "configured");
      throw error;
    }
  }

  async saveVaultPath(input: string): Promise<AppSettings> {
    const vaultPath = normalize(input.trim());
    if (!vaultPath || !isAbsolute(vaultPath)) throw new Error("Enter an absolute path to an existing Obsidian vault folder");
    let details;
    try { details = await stat(vaultPath); }
    catch (error) {
      if (isMissing(error)) throw new Error("The selected vault folder does not exist");
      throw error;
    }
    if (!details.isDirectory()) throw new Error("The selected vault path is not a folder");

    const content = `${JSON.stringify({ schemaVersion: SETTINGS_SCHEMA_VERSION, obsidianVaultPath: vaultPath }, null, 2)}\n`;
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, this.path);
    return this.describe(vaultPath, "saved");
  }

  private async describe(vaultPath: string, source: AppSettings["source"]): Promise<AppSettings> {
    try {
      const details = await stat(join(vaultPath, ".obsidian"));
      if (details.isDirectory()) return { vaultPath, source };
    } catch (error) { if (!isMissing(error)) throw error; }
    return { vaultPath, source, warning: "This folder does not contain an .obsidian directory; confirm it is the intended vault" };
  }
}

function isSettingsFile(input: unknown): input is { readonly schemaVersion: typeof SETTINGS_SCHEMA_VERSION; readonly obsidianVaultPath: string } {
  return typeof input === "object" && input !== null
    && "schemaVersion" in input && input.schemaVersion === SETTINGS_SCHEMA_VERSION
    && "obsidianVaultPath" in input && typeof input.obsidianVaultPath === "string"
    && isAbsolute(input.obsidianVaultPath);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
