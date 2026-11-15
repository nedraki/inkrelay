import { resolve } from "node:path";
import type { InkRelayConfig } from "./engine.js";

export type ServerConfig = InkRelayConfig & {
  readonly port: number;
  readonly host: string;
  readonly pythonServiceUrl: string;
  readonly languageWorkerUrl: string;
  readonly languageReviewTimeoutMs: number;
  readonly bluetoothEnabled: boolean;
  readonly automaticPaperEnabled?: boolean;
};

export function loadConfig(cwd = process.cwd()): ServerConfig {
  try { process.loadEnvFile(resolve(cwd, ".env")); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  return {
    canonicalDataPath: resolve(cwd, process.env.INKRELAY_DATA_PATH ?? "tmp/inkrelay-data/raw"),
    vaultPath: resolve(cwd, process.env.OBSIDIAN_VAULT_PATH ?? "tmp/demo-vault"),
    actionZonesPath: resolve(cwd, "config/action-zones.json"),
    paperProfilesPath: resolve(cwd, process.env.INKRELAY_PAPER_PROFILES_PATH ?? "tmp/inkrelay-data/paper-profiles.json"),
    paperDefinitionsPath: resolve(cwd, process.env.INKRELAY_PAPER_DEFINITIONS_PATH ?? "tmp/inkrelay-data/paper-definitions.json"),
    notebookInstancesPath: resolve(cwd, process.env.INKRELAY_NOTEBOOK_INSTANCES_PATH ?? "tmp/inkrelay-data/notebook-instances.json"),
    pageWidth: numberEnv("SMARTPEN_DEFAULT_PAGE_WIDTH", 1480),
    pageHeight: numberEnv("SMARTPEN_DEFAULT_PAGE_HEIGHT", 2100),
    port: numberEnv("INKRELAY_PORT", 4317),
    host: process.env.INKRELAY_HOST ?? "127.0.0.1",
    pythonServiceUrl: process.env.INKRELAY_PYTHON_SERVICE_URL ?? "http://127.0.0.1:8321",
    languageWorkerUrl: process.env.INKRELAY_LANGUAGE_WORKER_URL ?? process.env.INKRELAY_PYTHON_SERVICE_URL ?? "http://127.0.0.1:8321",
    languageReviewTimeoutMs: numberEnv("INKRELAY_LANGUAGE_REVIEW_TIMEOUT_MS", 3_600_000),
    bluetoothEnabled: process.env.INKRELAY_BLUETOOTH_ENABLED !== "false",
    automaticPaperEnabled: process.env.INKRELAY_AUTOMATIC_PAPER_ENABLED !== "false"
  };
}
function numberEnv(name: string, fallback: number): number { const value = Number(process.env[name] ?? fallback); if (!Number.isFinite(value)) throw new Error(`${name} must be a number`); return value; }
