import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { ReplayPenAdapter, WebBluetoothNeoAdapter } from "@inkrelay/adapters";
import { event } from "./helpers.js";

describe("pen adapters", () => {
  it("replays JSONL while preserving original source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inkrelay-replay-"));
    const path = join(directory, "events.jsonl");
    await writeFile(path, `${JSON.stringify(event(1, "pen_down"))}\n`);
    const callback = vi.fn();
    const adapter = new ReplayPenAdapter(path);
    adapter.onDot(callback);
    await adapter.connect();
    expect(await adapter.replay()).toBe(1);
    expect(callback.mock.calls[0]?.[0].source).toBe("mock");
  });
  it("exposes a clear production BLE placeholder", async () => { await expect(new WebBluetoothNeoAdapter().connect()).rejects.toThrow("not implemented"); });
});
