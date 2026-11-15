import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { NEO_V2_COMMAND, NeoFrameDecoder, NeoProtocolV2, type NeoProtocolEvent } from "@inkrelay/adapters";

describe("Neo protocol v2", () => {
  it("frames, escapes, and reassembles packets split across BLE notifications", () => {
    const packets: Array<{ command: number; data: Uint8Array }> = [];
    const decoder = new NeoFrameDecoder((packet) => packets.push(packet));
    const frame = NeoProtocolV2.encodeFrame(0x11, Uint8Array.of(0xc0, 0xc1, 0x7d, 0x42));
    decoder.push(frame.subarray(0, 3));
    decoder.push(frame.subarray(3));
    expect(packets).toHaveLength(1);
    expect(packets[0]?.command).toBe(0x11);
    expect([...packets[0]!.data]).toEqual([0xc0, 0xc1, 0x7d, 0x42]);
  });

  it("accepts a protocol-2.20 offline frame with a stale outer length", () => {
    const packets: Array<{ command: number; data: Uint8Array }> = [];
    const warnings: string[] = [];
    const decoder = new NeoFrameDecoder((packet) => packets.push(packet), (warning) => warnings.push(warning));
    const frame = NeoProtocolV2.encodeFrame(NEO_V2_COMMAND.OFFLINE_PACKET_REQUEST, Uint8Array.of(1, 2, 3, 4));
    frame[2] = 3;
    decoder.push(frame);
    expect(packets).toMatchObject([{ command: NEO_V2_COMMAND.OFFLINE_PACKET_REQUEST, data: Uint8Array.of(1, 2, 3, 4) }]);
    expect(warnings).toEqual([]);
  });

  it("negotiates an unlocked pen and emits normalized live events", async () => {
    const writes: Uint8Array[] = [];
    const events: NeoProtocolEvent[] = [];
    const protocol = new NeoProtocolV2(async (data) => { writes.push(data); }, (event) => events.push(event));
    await protocol.start();
    protocol.receive(response(NEO_V2_COMMAND.VERSION_RESPONSE, versionPayload()));
    protocol.receive(response(NEO_V2_COMMAND.SETTING_INFO_RESPONSE, statusPayload(false)));

    protocol.receive(eventFrame(NEO_V2_COMMAND.NEW_PEN_DOWN, concat(u8(1), i64(10_000), u8(0), i32(0xff111111))));
    protocol.receive(eventFrame(NEO_V2_COMMAND.NEW_PAPER_INFO, concat(u8(2), ownerSection(2, 7), i32(101), i32(12))));
    protocol.receive(eventFrame(NEO_V2_COMMAND.NEW_PEN_DOT, concat(u8(3), u8(5), i16(400), u16(120), u16(240), u8(20), u8(50))));
    protocol.receive(eventFrame(NEO_V2_COMMAND.NEW_PEN_UP, concat(u8(4), i64(10_020), i16(1), i16(1), i16(1), i16(1), i16(1))));

    expect(events.some((event) => event.type === "device_info")).toBe(true);
    expect(events.some((event) => event.type === "authenticated")).toBe(true);
    const dots = events.filter((event): event is Extract<NeoProtocolEvent, { type: "dot" }> => event.type === "dot").map((event) => event.event);
    expect(dots).toMatchObject([
      { eventType: "pen_down", notebookId: "NEO_2_7_101", pageId: 12, x: 1202, y: 2405, pressure: 400, timestampMs: 10_005 },
      { eventType: "pen_up", notebookId: "NEO_2_7_101", pageId: 12, sequence: 2 }
    ]);
    expect(commands(writes)).toEqual(expect.arrayContaining([NEO_V2_COMMAND.VERSION_REQUEST, NEO_V2_COMMAND.SETTING_INFO_REQUEST, NEO_V2_COMMAND.ONLINE_DATA_REQUEST, NEO_V2_COMMAND.OFFLINE_NOTE_LIST_REQUEST]));
  });

  it("persists parsed offline strokes before acknowledging without deletion", async () => {
    const writes: Uint8Array[] = [];
    const events: NeoProtocolEvent[] = [];
    let releasePersistence = (): void => undefined;
    const persistenceGate = new Promise<void>((resolve) => { releasePersistence = resolve; });
    const protocol = new NeoProtocolV2(async (data) => { writes.push(data); }, async (event) => {
      if (event.type === "dot") await persistenceGate;
      events.push(event);
    });
    protocol.receive(response(NEO_V2_COMMAND.VERSION_RESPONSE, versionPayload()));
    protocol.receive(response(NEO_V2_COMMAND.SETTING_INFO_RESPONSE, statusPayload(false)));
    protocol.receive(response(NEO_V2_COMMAND.OFFLINE_DATA_RESPONSE, concat(i32(1), i32(100), u8(1))));

    const stroke = concat(i32(12), i64(20_000), i64(20_020), u8(0), i32(0xffe53935), i16(2), offlineDot(5, 410, 100, 200, 10, 20), offlineDot(10, 420, 110, 210, 30, 40));
    const compressed = deflateSync(stroke);
    const packet = concat(i16(7), u8(1), i16(stroke.length), i16(compressed.length), u8(2), ownerSection(3, 8), i32(102), i16(1), compressed);
    protocol.receive(eventFrame(NEO_V2_COMMAND.OFFLINE_PACKET_REQUEST, packet));

    expect(commands(writes)).not.toContain(NEO_V2_COMMAND.OFFLINE_PACKET_RESPONSE);
    releasePersistence();
    await vi.waitFor(() => expect(events).toContainEqual({ type: "offline_finished", success: true }));

    const dots = events.filter((event): event is Extract<NeoProtocolEvent, { type: "dot" }> => event.type === "dot").map((event) => event.event);
    expect(dots).toMatchObject([
      { eventType: "pen_down", source: "native_bridge", notebookId: "NEO_3_8_102", pageId: 12, x: 1001, y: 2002, color: "#e53935" },
      { eventType: "pen_up", notebookId: "NEO_3_8_102", x: 1103, y: 2104 }
    ]);
    expect(events).toContainEqual({ type: "offline_finished", success: true });
    expect(commands(writes)).toContain(NEO_V2_COMMAND.OFFLINE_PACKET_RESPONSE);
  });

  it("accepts validated offline data when Neo firmware appends opaque packet bytes", async () => {
    const writes: Uint8Array[] = [];
    const events: NeoProtocolEvent[] = [];
    const protocol = new NeoProtocolV2(async (data) => { writes.push(data); }, (event) => events.push(event));
    protocol.receive(response(NEO_V2_COMMAND.VERSION_RESPONSE, versionPayload()));
    protocol.receive(response(NEO_V2_COMMAND.SETTING_INFO_RESPONSE, statusPayload(false)));
    protocol.receive(response(NEO_V2_COMMAND.OFFLINE_DATA_RESPONSE, concat(i32(1), i32(100), u8(1))));

    const stroke = concat(i32(82), i64(30_000), i64(30_020), u8(0), i32(0xff111111), i16(2), offlineDot(5, 410, 90, 85, 10, 20), offlineDot(10, 420, 550, 890, 30, 40));
    const compressed = deflateSync(stroke);
    const firmwareTrailer = new Uint8Array(502).fill(0xa5);
    const packet = concat(i16(47), u8(1), i16(stroke.length), i16(compressed.length), u8(2), ownerSection(3, 27), i32(701), i16(1), compressed, firmwareTrailer);
    protocol.receive(eventFrame(NEO_V2_COMMAND.OFFLINE_PACKET_REQUEST, packet));

    await vi.waitFor(() => expect(events).toContainEqual({ type: "offline_finished", success: true }));
    expect(events.filter((event) => event.type === "dot")).toHaveLength(2);
    expect(events.filter((event) => event.type === "warning")).toEqual([]);
    expect(commands(writes)).toContain(NEO_V2_COMMAND.OFFLINE_PACKET_RESPONSE);
  });
});

function response(command: number, payload: Uint8Array): Uint8Array { return NeoProtocolV2.encodeFrame(command, payload, 0); }
function eventFrame(command: number, payload: Uint8Array): Uint8Array { return NeoProtocolV2.encodeFrame(command, payload); }
function versionPayload(): Uint8Array { return concat(fixed("NWP-F121", 16), fixed("1.00", 16), fixed("2.12", 8), fixed("LAMY", 16), u16(1), Uint8Array.of(1, 2, 3, 4, 5, 6), u8(0)); }
function statusPayload(locked: boolean): Uint8Array { return concat(u8(locked ? 1 : 0), u8(10), u8(0), i64(9_000), i16(20), i16(1023), u8(12), u8(1), u8(1), u8(1), u8(0), u8(88), u8(1), i16(2)); }
function ownerSection(section: number, owner: number): Uint8Array { return Uint8Array.of(owner & 255, (owner >>> 8) & 255, (owner >>> 16) & 255, section); }
function offlineDot(delta: number, pressure: number, x: number, y: number, fx: number, fy: number): Uint8Array {
  const body = concat(u8(delta), i16(pressure), u16(x), u16(y), u8(fx), u8(fy), u8(0), u8(0), i16(0), i16(0));
  return concat(body, u8([...body].reduce((sum, value) => (sum + value) & 255, 0)));
}
function commands(frames: readonly Uint8Array[]): number[] { const result: number[] = []; const decoder = new NeoFrameDecoder((packet) => result.push(packet.command)); for (const frame of frames) decoder.push(frame); return result; }
function fixed(value: string, length: number): Uint8Array { const result = new Uint8Array(length); result.set(new TextEncoder().encode(value)); return result; }
function u8(value: number): Uint8Array { return Uint8Array.of(value & 255); }
function i16(value: number): Uint8Array { const result = new Uint8Array(2); new DataView(result.buffer).setInt16(0, value, true); return result; }
function u16(value: number): Uint8Array { const result = new Uint8Array(2); new DataView(result.buffer).setUint16(0, value, true); return result; }
function i32(value: number): Uint8Array { const result = new Uint8Array(4); new DataView(result.buffer).setInt32(0, value, true); return result; }
function i64(value: number): Uint8Array { const result = new Uint8Array(8); new DataView(result.buffer).setBigInt64(0, BigInt(value), true); return result; }
function concat(...chunks: readonly Uint8Array<ArrayBufferLike>[]): Uint8Array { const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0)); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; } return output; }
