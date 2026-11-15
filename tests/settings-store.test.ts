import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppSettingsStore } from "../apps/server/src/settings-store.js";

describe("app settings", () => {
  it("persists an Obsidian vault override across store instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkrelay-settings-"));
    const configuredVault = join(root, "configured-vault");
    const selectedVault = join(root, "selected-vault");
    const settingsPath = join(root, "data", "settings.json");
    await mkdir(join(selectedVault, ".obsidian"), { recursive: true });

    expect(await new AppSettingsStore(settingsPath, configuredVault).load()).toMatchObject({ vaultPath: configuredVault, source: "configured", warning: expect.any(String) });
    await new AppSettingsStore(settingsPath, configuredVault).saveVaultPath(selectedVault);
    expect(await new AppSettingsStore(settingsPath, configuredVault).load()).toEqual({ vaultPath: selectedVault, source: "saved" });
  });
});
