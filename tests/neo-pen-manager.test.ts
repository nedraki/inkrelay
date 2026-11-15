import { describe, expect, it, vi } from "vitest";
import { NEO_V2_COMMAND, NeoFrameDecoder, NeoPenManager, NeoProtocolV2, type DiscoveredPen, type NeoPenTransport, type NeoProtocolEvent } from "@inkrelay/adapters";
import { event } from "./helpers.js";

describe("NeoPenManager", () => {
  it("discovers a model-independent Neo pen and reaches password negotiation", async () => {
    const transport = new FakeTransport();
    const manager = new NeoPenManager(vi.fn(), transport);
    await manager.initialize();
    expect(manager.snapshot().bluetooth).toMatchObject({ available: true, adapterName: "Fake BlueZ" });
    expect(await manager.scan(1_000)).toMatchObject([{ name: "LAMY safari", neoCompatible: true }]);
    await manager.connect("/org/bluez/hci0/dev_FA_KE");
    expect(manager.snapshot().connection).toBe("negotiating");
    transport.receive(NeoProtocolV2.encodeFrame(NEO_V2_COMMAND.VERSION_RESPONSE, versionPayload(), 0));
    transport.receive(NeoProtocolV2.encodeFrame(NEO_V2_COMMAND.SETTING_INFO_RESPONSE, statusPayload(true), 0));
    expect(manager.snapshot()).toMatchObject({ connection: "password_required", deviceInfo: { subName: "LAMY" }, penStatus: { batteryPercent: 75 } });
  });

  it("can initialize again after Bluetooth was temporarily unavailable", async () => {
    const transport = new RecoveringTransport();
    const manager = new NeoPenManager(vi.fn(), transport);
    await manager.initialize();
    expect(manager.snapshot().bluetooth).toMatchObject({ available: false, error: "BlueZ temporarily unavailable" });
    await manager.initialize();
    expect(manager.snapshot().bluetooth).toMatchObject({ available: true, adapterName: "Recovered BlueZ" });
    expect(transport.initializeAttempts).toBe(2);
  });

  it("reports accepted and duplicate offline strokes truthfully without emitting per dot", async () => {
    const onDot = vi.fn()
      .mockResolvedValueOnce({ accepted: true })
      .mockResolvedValueOnce({ accepted: false });
    const manager = new NeoPenManager(onDot, new FakeTransport());
    let emissions = 0;
    manager.subscribe(() => { emissions += 1; });
    const handler = manager as unknown as { handleProtocolEvent(protocolEvent: NeoProtocolEvent): void | Promise<void> };
    await handler.handleProtocolEvent({ type: "dot", origin: "offline", event: event(1, "pen_down", { sessionId: "new-stroke" }) });
    await handler.handleProtocolEvent({ type: "dot", origin: "offline", event: event(1, "pen_down", { sessionId: "duplicate-stroke" }) });
    expect(manager.snapshot().sync).toMatchObject({ importedStrokes: 1, duplicateStrokes: 1 });
    expect(emissions).toBe(0);
  });
});

class FakeTransport implements NeoPenTransport {
  private data: (data: Uint8Array) => void = () => undefined;
  private disconnected: (reason?: string) => void = () => undefined;
  readonly writes: Uint8Array[] = [];
  readonly pen: DiscoveredPen = { deviceId: "/org/bluez/hci0/dev_FA_KE", address: "FA:KE", name: "LAMY safari", paired: false, connected: false, serviceUuids: ["4f99f138-9d53-5bfa-9e50-b147491afe68"], neoCompatible: true };
  async initialize(): Promise<{ adapterName: string }> { return { adapterName: "Fake BlueZ" }; }
  async scan(_durationMs: number): Promise<readonly DiscoveredPen[]> { return [this.pen]; }
  async devices(): Promise<readonly DiscoveredPen[]> { return [this.pen]; }
  async connect(_deviceId: string): Promise<void> {}
  async disconnect(): Promise<void> { this.disconnected(); }
  async write(data: Uint8Array): Promise<void> { this.writes.push(data); }
  onData(callback: (data: Uint8Array) => void): void { this.data = callback; }
  onDisconnect(callback: (reason?: string) => void): void { this.disconnected = callback; }
  receive(data: Uint8Array): void { this.data(data); }
}

class RecoveringTransport extends FakeTransport {
  initializeAttempts = 0;
  override async initialize(): Promise<{ adapterName: string }> {
    this.initializeAttempts += 1;
    if (this.initializeAttempts === 1) throw new Error("BlueZ temporarily unavailable");
    return { adapterName: "Recovered BlueZ" };
  }
}

function versionPayload(): Uint8Array { return concat(fixed("NWP-F121", 16), fixed("1.00", 16), fixed("2.12", 8), fixed("LAMY", 16), u16(1), Uint8Array.of(1, 2, 3, 4, 5, 6), Uint8Array.of(0)); }
function statusPayload(locked: boolean): Uint8Array { return concat(Uint8Array.of(locked ? 1 : 0, 10, 0), i64(9_000), i16(20), i16(1023), Uint8Array.of(12, 1, 1, 1, 0, 75, 1), i16(2)); }
function fixed(value: string, length: number): Uint8Array { const result = new Uint8Array(length); result.set(new TextEncoder().encode(value)); return result; }
function i16(value: number): Uint8Array { const result = new Uint8Array(2); new DataView(result.buffer).setInt16(0, value, true); return result; }
function u16(value: number): Uint8Array { const result = new Uint8Array(2); new DataView(result.buffer).setUint16(0, value, true); return result; }
function i64(value: number): Uint8Array { const result = new Uint8Array(8); new DataView(result.buffer).setBigInt64(0, BigInt(value), true); return result; }
function concat(...chunks: readonly Uint8Array<ArrayBufferLike>[]): Uint8Array { const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0)); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; } return output; }
