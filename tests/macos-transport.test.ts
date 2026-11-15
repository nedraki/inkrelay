import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BluezNeoTransport, MacosNeoTransport, UnsupportedNeoTransport, createNativeNeoTransport, NeoPenManager } from "@inkrelay/adapters";

const transports: MacosNeoTransport[] = [];
afterEach(async () => { await Promise.all(transports.splice(0).map((transport) => transport.dispose())); });
function transport(mode = "normal", timeoutMs = 2000): MacosNeoTransport {
  const result = new MacosNeoTransport({ timeoutMs, spawnHelper: () => spawn(process.execPath, [resolve("fixtures/fake-bluetooth-helper.mjs"), mode]) });
  transports.push(result);
  return result;
}
const deviceId = "11111111-1111-A111-0111-111111111111";

describe("native transport selection", () => {
  it("selects Linux and macOS implementations without starting either", async () => {
    expect(createNativeNeoTransport("linux")).toBeInstanceOf(BluezNeoTransport);
    expect(createNativeNeoTransport("darwin")).toBeInstanceOf(MacosNeoTransport);
    const windows = createNativeNeoTransport("win32");
    expect(windows).toBeInstanceOf(UnsupportedNeoTransport);
    await expect(windows.initialize()).rejects.toThrow("not implemented for win32");
  });
});

describe("macOS Bluetooth pipe transport", () => {
  it("discovers opaque peripheral IDs and preserves exact notification bytes", async () => {
    const native = transport();
    const received: number[][] = [];
    const disconnected = vi.fn();
    native.onData((bytes) => received.push([...bytes]));
    native.onDisconnect(disconnected);
    expect(await native.initialize()).toEqual({ adapterName: "Synthetic Core Bluetooth" });
    expect(await native.devices()).toMatchObject([{ deviceId, address: deviceId, paired: false, connected: false, neoCompatible: true }]);
    expect(await native.scan(1000)).toMatchObject([{ name: "LAMY synthetic" }]);
    await native.connect(deviceId);
    // Pipe messages are ordered: the subsequent write response follows the
    // initial notifications, so no sleeps are needed to assert their delivery.
    const original = Uint8Array.of(0xc0, 0x7d, 0xc1, 0, 255);
    const writing = native.write(original);
    original.fill(1);
    await writing;
    expect(received).toEqual([[4, 5, 6], [0xc0, 0x7d, 0xc1, 0, 255]]);
    await native.disconnect();
    await native.devices();
    expect(received).toHaveLength(2); // Late notifications are ignored.
    expect(disconnected).not.toHaveBeenCalled();
    await expect(native.write(Uint8Array.of(1))).rejects.toThrow("not connected");
  });

  it("serializes complete frames and never interleaves concurrent writes", async () => {
    const native = transport();
    const received: number[][] = [];
    native.onData((bytes) => received.push([...bytes]));
    await native.initialize();
    await native.connect(deviceId);
    await Promise.all([native.write(Uint8Array.of(10, 11)), native.write(Uint8Array.of(12, 13)), native.write(Uint8Array.of(14, 15))]);
    expect(received).toEqual([[4, 5, 6], [10, 11], [12, 13], [14, 15]]);
  });

  it("rejects frames queued before a disconnect instead of sending them after reconnection", async () => {
    const native = transport("slow-write");
    await native.initialize();
    await native.connect(deviceId);
    const queued = native.write(Uint8Array.of(1));
    const rejected = expect(queued).rejects.toThrow("not connected");
    await native.disconnect();
    await rejected;
    await native.connect(deviceId);
    await native.write(Uint8Array.of(2));
  });

  it("propagates permission errors and lets the pen manager retry", async () => {
    const native = transport("deny-once");
    const manager = new NeoPenManager(vi.fn(), native);
    await manager.initialize();
    expect(manager.snapshot().bluetooth).toMatchObject({ available: false, error: "Bluetooth permission denied" });
    // A native permission denial must be retryable on the same helper process.
    await manager.initialize();
    expect(manager.snapshot().bluetooth).toMatchObject({ available: true, adapterName: "Synthetic Core Bluetooth" });
    await manager.close();
  });

  it.each(["malformed", "wrong-version", "oversized", "bad-result", "crash"])("fails closed on %s helper output and can retry", async (mode) => {
    let launches = 0;
    const native = new MacosNeoTransport({ timeoutMs: 2000, spawnHelper: () => spawn(process.execPath,
      [resolve("fixtures/fake-bluetooth-helper.mjs"), launches++ === 0 ? mode : "normal"]) });
    transports.push(native);
    await expect(native.initialize()).rejects.toThrow();
    expect(await native.initialize()).toMatchObject({ adapterName: "Synthetic Core Bluetooth" });
  });

  it("terminates a timed-out helper and rejects pending requests", async () => {
    const native = transport("hang", 100);
    await expect(native.initialize()).rejects.toThrow("timed out");
    await expect(native.devices()).rejects.toThrow("not been initialized");
  });

  it.each(["write-crash", "disconnect-on-write", "write-invalid-data"])("reports %s and invalidates the active connection", async (mode) => {
    const native = transport(mode);
    const disconnected = vi.fn();
    native.onDisconnect(disconnected);
    await native.initialize();
    await native.connect(deviceId);
    try { await native.write(Uint8Array.of(1)); } catch { /* The bridge may acknowledge before the subsequent fatal event. */ }
    // Wait for the event itself rather than relying on IPC timing.
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledTimes(1));
    await expect(native.write(Uint8Array.of(2))).rejects.toThrow("not connected");
  });

  it("reports a missing helper and releases its failed request", async () => {
    const native = new MacosNeoTransport({ spawnHelper: () => spawn(resolve("fixtures/no-such-bluetooth-helper")) });
    transports.push(native);
    await expect(native.initialize()).rejects.toThrow("helper");
  });

  it("closing the transport terminates its helper, rejects work, and does not emit a spurious disconnect", async () => {
    let child: ChildProcessWithoutNullStreams | undefined;
    const native = new MacosNeoTransport({ timeoutMs: 2000, spawnHelper: () => {
      child = spawn(process.execPath, [resolve("fixtures/fake-bluetooth-helper.mjs"), "hang"]);
      return child;
    } });
    transports.push(native);
    const disconnected = vi.fn();
    native.onDisconnect(disconnected);
    const initializing = native.initialize();
    const failed = expect(initializing).rejects.toThrow("closed");
    await native.dispose();
    await failed;
    expect(child?.killed).toBe(true);
    expect(disconnected).not.toHaveBeenCalled();
  });
});
