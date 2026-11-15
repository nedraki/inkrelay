import { inflateSync } from "node:zlib";
import { PEN_EVENT_SCHEMA_VERSION, type PenDotEvent } from "@inkrelay/core";
import type { NeoDeviceInfo, NeoOfflineNote, NeoPenStatus, NeoProtocolEvent } from "./neo-types.js";

const STX = 0xc0;
const ETX = 0xc1;
const DLE = 0x7d;
// Neo protocol-v2 positions are reported in millimetre-scale units with a
// hundredth-unit fractional component. InkRelay's
// default 1480x2100 page is an A5-like 148x210 mm surface at 10 px/mm.
const NEO_TO_APP_PX = 10;

export const NEO_V2_COMMAND = {
  VERSION_REQUEST: 0x01, VERSION_RESPONSE: 0x81,
  PASSWORD_REQUEST: 0x02, PASSWORD_RESPONSE: 0x82,
  SETTING_INFO_REQUEST: 0x04, SETTING_INFO_RESPONSE: 0x84,
  SETTING_CHANGE_REQUEST: 0x05,
  ONLINE_DATA_REQUEST: 0x11,
  PEN_UPDOWN: 0x63, PAPER_INFO: 0x64, PEN_DOT: 0x65,
  NEW_PEN_DOWN: 0x69, NEW_PEN_UP: 0x6a, NEW_PAPER_INFO: 0x6b, NEW_PEN_DOT: 0x6c,
  OFFLINE_NOTE_LIST_REQUEST: 0x21, OFFLINE_NOTE_LIST_RESPONSE: 0xa1,
  OFFLINE_PAGE_LIST_REQUEST: 0x22, OFFLINE_PAGE_LIST_RESPONSE: 0xa2,
  OFFLINE_DATA_REQUEST: 0x23, OFFLINE_DATA_RESPONSE: 0xa3,
  OFFLINE_PACKET_REQUEST: 0x24, OFFLINE_PACKET_RESPONSE: 0xa4,
  LOW_BATTERY: 0x61
} as const;

type Packet = { readonly command: number; readonly result?: number; readonly data: Uint8Array };
type Bytes = Uint8Array<ArrayBufferLike>;
type Paper = { readonly section: number; readonly owner: number; readonly note: number; readonly page: number };
type LastPoint = Paper & { readonly timestampMs: number; readonly x: number; readonly y: number; readonly pressure: number; readonly color?: string };

const RESPONSE_COMMANDS = new Set([0x81, 0x82, 0x83, 0x84, 0x85, 0x91, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xb1, 0xb2, 0xc1, 0xf6]);

export class NeoProtocolV2 {
  private readonly decoder: NeoFrameDecoder;
  private info: NeoDeviceInfo | undefined;
  private status: NeoPenStatus | undefined;
  private currentPaper: Paper | undefined;
  private penDownTimestamp = -1;
  private liveSequence = 0;
  private liveSessionId = "";
  private lastPoint: LastPoint | undefined;
  private totalOfflineStrokes = 0;
  private receivedOfflineStrokes = 0;

  constructor(
    private readonly writePacket: (data: Uint8Array) => Promise<void>,
    private readonly emit: (event: NeoProtocolEvent) => unknown
  ) { this.decoder = new NeoFrameDecoder((packet) => this.handle(packet), (message) => this.warn(message)); }

  start(): Promise<void> { return this.write(NEO_V2_COMMAND.VERSION_REQUEST, versionPayload()); }
  receive(data: Uint8Array): void { this.decoder.push(data); }
  requestStatus(): Promise<void> { return this.write(NEO_V2_COMMAND.SETTING_INFO_REQUEST); }
  enableLiveMode(): Promise<void> { return this.write(NEO_V2_COMMAND.ONLINE_DATA_REQUEST, Uint8Array.of(0xff, 0xff)); }
  requestOfflineNotes(): Promise<void> { return this.write(NEO_V2_COMMAND.OFFLINE_NOTE_LIST_REQUEST, Uint8Array.of(0xff, 0xff, 0xff, 0xff)); }
  requestOfflinePages(note: NeoOfflineNote): Promise<void> { return this.write(NEO_V2_COMMAND.OFFLINE_PAGE_LIST_REQUEST, concat(sectionOwner(note.section, note.owner), int32(note.note))); }
  requestOfflineData(note: NeoOfflineNote): Promise<void> {
    const pages = note.pages ?? [];
    return this.write(NEO_V2_COMMAND.OFFLINE_DATA_REQUEST, concat(
      Uint8Array.of(2, 1), // Keep source data on the pen after a successful sync.
      sectionOwner(note.section, note.owner), int32(note.note), int32(pages.length), ...pages.map(int32)
    ));
  }
  authenticate(password: string): Promise<void> {
    if (!password || password.length > 16) return Promise.reject(new Error("Pen password must contain 1–16 characters"));
    return this.write(NEO_V2_COMMAND.PASSWORD_REQUEST, fixedString(password, 16));
  }

  static encodeFrame(command: number, payload: Bytes = new Uint8Array(), result?: number): Uint8Array {
    const body = concat(Uint8Array.of(command), result === undefined ? new Uint8Array() : Uint8Array.of(result), uint16(payload.length), payload);
    const escaped: number[] = [STX];
    for (const byte of body) {
      if (byte === STX || byte === ETX || byte === DLE) escaped.push(DLE, byte ^ 0x20);
      else escaped.push(byte);
    }
    escaped.push(ETX);
    return Uint8Array.from(escaped);
  }

  private write(command: number, payload: Bytes = new Uint8Array(), result?: number): Promise<void> {
    return this.writePacket(NeoProtocolV2.encodeFrame(command, payload, result));
  }

  private handle(packet: Packet): void {
    try {
      switch (packet.command) {
        case NEO_V2_COMMAND.VERSION_RESPONSE: this.handleVersion(packet.data); break;
        case NEO_V2_COMMAND.SETTING_INFO_RESPONSE: this.handleStatus(packet.data); break;
        case NEO_V2_COMMAND.PASSWORD_RESPONSE: this.handlePassword(packet.data); break;
        case NEO_V2_COMMAND.NEW_PEN_DOWN: this.handleNewDown(packet.data); break;
        case NEO_V2_COMMAND.NEW_PEN_UP: this.handleNewUp(packet.data); break;
        case NEO_V2_COMMAND.PEN_UPDOWN: this.handleLegacyUpDown(packet.data); break;
        case NEO_V2_COMMAND.PAPER_INFO:
        case NEO_V2_COMMAND.NEW_PAPER_INFO: this.handlePaper(packet.command, packet.data); break;
        case NEO_V2_COMMAND.PEN_DOT:
        case NEO_V2_COMMAND.NEW_PEN_DOT: this.handleDot(packet.command, packet.data); break;
        case NEO_V2_COMMAND.OFFLINE_NOTE_LIST_RESPONSE: this.handleOfflineNotes(packet.data); break;
        case NEO_V2_COMMAND.OFFLINE_PAGE_LIST_RESPONSE: this.handleOfflinePages(packet.data); break;
        case NEO_V2_COMMAND.OFFLINE_DATA_RESPONSE: this.handleOfflineStart(packet.data); break;
        case NEO_V2_COMMAND.OFFLINE_PACKET_REQUEST: this.handleOfflinePacket(packet.data); break;
        case NEO_V2_COMMAND.LOW_BATTERY: this.emit({ type: "battery_low", batteryPercent: packet.data[0] ?? 0 }); break;
        default: break;
      }
    } catch (error) { this.warn(`Neo packet 0x${packet.command.toString(16)} could not be parsed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private handleVersion(data: Uint8Array): void {
    const reader = new Reader(data);
    const info: NeoDeviceInfo = {
      deviceName: reader.string(16), firmwareVersion: reader.string(16), protocolVersion: reader.string(8), subName: reader.string(16),
      deviceType: reader.u16(), macAddress: [...reader.bytes(6)].map((byte) => byte.toString(16).padStart(2, "0")).join(":").toUpperCase(),
      pressureSensorType: reader.remaining ? reader.u8() : 0
    };
    this.info = info;
    this.emit({ type: "device_info", info });
    this.background(this.requestStatus(), "Pen status request");
  }

  private handleStatus(data: Uint8Array): void {
    const reader = new Reader(data);
    const status: NeoPenStatus = {
      locked: reader.u8() === 1, passwordMaxRetries: reader.u8(), passwordRetries: reader.u8(), timestampMs: Number(reader.i64()),
      autoPowerOffMinutes: reader.i16(), maxForce: reader.i16(), usedStoragePercent: reader.u8()
      , offlineDataEnabled: false, hoverEnabled: false, batteryPercent: 0
    };
    reader.u8(); // pen-cap power-off
    reader.u8(); // auto power-on
    reader.u8(); // beep
    const hoverEnabled = reader.u8() === 1;
    const batteryPercent = reader.u8();
    const offlineDataEnabled = reader.u8() === 1;
    if (reader.remaining >= 2) reader.i16(); // force sensitivity
    const complete = { ...status, hoverEnabled, batteryPercent, offlineDataEnabled };
    this.status = complete;
    this.emit({ type: "status", status: complete });
    if (complete.locked) this.emit({ type: "password_required", retries: complete.passwordRetries, maxRetries: complete.passwordMaxRetries });
    else this.authenticated();
  }

  private handlePassword(data: Uint8Array): void {
    const reader = new Reader(data);
    const accepted = reader.u8() === 1;
    const retries = reader.u8();
    const maxRetries = reader.u8();
    if (accepted) this.authenticated();
    else this.emit({ type: "password_rejected", retries, maxRetries });
  }

  private authenticated(): void {
    this.emit({ type: "authenticated" });
    this.background(this.enableLiveMode(), "Live-mode activation");
    this.background(this.requestOfflineNotes(), "Offline-note discovery");
  }

  private handleNewDown(data: Uint8Array): void {
    const reader = new Reader(data);
    reader.u8(); // event sequence from pen
    this.penDownTimestamp = Number(reader.i64());
    reader.u8(); // tip type
    if (reader.remaining >= 4) reader.i32(); // physical ink color
    this.liveSequence = 0;
    this.liveSessionId = `live-${penId(this.info)}-${this.penDownTimestamp}`;
    this.lastPoint = undefined;
  }

  private handleNewUp(data: Uint8Array): void {
    const reader = new Reader(data);
    reader.u8();
    if (reader.remaining >= 8) reader.i64();
    this.emitPenUp();
  }

  private handleLegacyUpDown(data: Uint8Array): void {
    const reader = new Reader(data);
    const down = reader.u8() === 0;
    if (down) {
      this.penDownTimestamp = Number(reader.i64());
      this.liveSequence = 0;
      this.liveSessionId = `live-${penId(this.info)}-${this.penDownTimestamp}`;
      this.lastPoint = undefined;
    } else this.emitPenUp();
  }

  private handlePaper(command: number, data: Uint8Array): void {
    const reader = new Reader(data);
    if (command === NEO_V2_COMMAND.NEW_PAPER_INFO) reader.u8();
    const ownerSection = reader.bytes(4);
    this.currentPaper = { section: ownerSection[3] ?? 0, owner: uint24(ownerSection), note: reader.i32(), page: reader.i32() };
  }

  private handleDot(command: number, data: Uint8Array): void {
    if (!this.currentPaper || this.penDownTimestamp < 0) { this.warn("Received a live dot before pen-down or paper metadata"); return; }
    const reader = new Reader(data);
    if (command === NEO_V2_COMMAND.NEW_PEN_DOT) reader.u8();
    const timeDelta = reader.u8();
    const timestampMs = (this.lastPoint?.timestampMs ?? this.penDownTimestamp) + timeDelta;
    const pressure = reader.i16();
    const baseX = reader.u16();
    const baseY = reader.u16();
    const x = baseX + reader.u8() * 0.01;
    const y = baseY + reader.u8() * 0.01;
    const point = { ...this.currentPaper, timestampMs, x, y, pressure };
    this.liveSequence++;
    void this.emit({ type: "dot", origin: "live", event: normalizedEvent(point, this.liveSequence === 1 ? "pen_down" : "pen_move", penId(this.info), this.liveSessionId, this.liveSequence) });
    this.lastPoint = point;
  }

  private emitPenUp(): void {
    if (this.lastPoint) {
      this.liveSequence++;
      void this.emit({ type: "dot", origin: "live", event: normalizedEvent(this.lastPoint, "pen_up", penId(this.info), this.liveSessionId, this.liveSequence) });
    }
    this.penDownTimestamp = -1;
    this.lastPoint = undefined;
  }

  private handleOfflineNotes(data: Uint8Array): void {
    const reader = new Reader(data);
    const count = reader.i16();
    const notes: NeoOfflineNote[] = [];
    for (let index = 0; index < count; index++) {
      const ownerSection = reader.bytes(4);
      notes.push({ section: ownerSection[3] ?? 0, owner: uint24(ownerSection), note: reader.i32() });
    }
    void this.emit({ type: "offline_notes", notes, completeList: true });
  }

  private handleOfflinePages(data: Uint8Array): void {
    const reader = new Reader(data);
    const ownerSection = reader.bytes(4);
    const note = reader.i32();
    const count = reader.i16();
    const pages = Array.from({ length: count }, () => reader.i32());
    void this.emit({ type: "offline_notes", notes: [{ section: ownerSection[3] ?? 0, owner: uint24(ownerSection), note, pages }], completeList: false });
  }

  private handleOfflineStart(data: Uint8Array): void {
    const reader = new Reader(data);
    this.totalOfflineStrokes = reader.i32();
    this.receivedOfflineStrokes = 0;
    const totalBytes = reader.i32();
    this.emit({ type: "offline_started", totalStrokes: this.totalOfflineStrokes, totalBytes });
    if (this.totalOfflineStrokes === 0) this.emit({ type: "offline_finished", success: true });
  }

  private handleOfflinePacket(data: Uint8Array): void {
    const reader = new Reader(data);
    const packetId = reader.i16();
    const compressed = reader.u8() === 1;
    const uncompressedSize = reader.i16();
    const wireSize = reader.i16();
    const location = reader.u8();
    const ownerSection = reader.bytes(4);
    const section = ownerSection[3] ?? 0;
    const owner = uint24(ownerSection);
    const note = reader.i32();
    const strokeCount = reader.i16();
    // Recent Neo firmware can append opaque bytes after the declared offline
    // data block. Neo's current Web SDK deliberately slices only the declared
    // block; the older UWP SDK rejected the whole packet instead. Keep those
    // bytes outside the canonical event stream and validate the declared block
    // through decompression, size, stroke parsing, and dot checksums below.
    const dataSize = compressed ? wireSize : uncompressedSize;
    const wire = reader.bytes(dataSize);
    let payload: Uint8Array;
    try { payload = compressed ? inflateSync(wire) : wire; }
    catch { this.background(this.ackOfflinePacket(packetId, false), `Offline packet ${packetId} rejection`); throw new Error(`offline packet ${packetId} decompression failed`); }
    if (payload.length !== uncompressedSize) { this.background(this.ackOfflinePacket(packetId, false), `Offline packet ${packetId} rejection`); throw new Error(`offline packet ${packetId} size mismatch`); }

    const strokes = new Reader(payload);
    const dotEvents: Extract<NeoProtocolEvent, { type: "dot" }>[] = [];
    for (let strokeIndex = 0; strokeIndex < strokeCount; strokeIndex++) {
      const page = strokes.i32();
      const startedAtMs = Number(strokes.i64());
      strokes.i64(); // recorded end timestamp
      strokes.u8(); // tip type
      const color = neoColor(strokes.i32());
      const dotCount = strokes.i16();
      let timestampMs = startedAtMs;
      const sessionId = `offline-${penId(this.info)}-${section}-${owner}-${note}-${page}-${startedAtMs}`;
      const points: LastPoint[] = [];
      for (let dotIndex = 0; dotIndex < dotCount; dotIndex++) {
        const checksumStart = strokes.offset;
        timestampMs += strokes.u8();
        const pressure = strokes.i16();
        const baseX = strokes.u16();
        const baseY = strokes.u16();
        const x = baseX + strokes.u8() * 0.01;
        const y = baseY + strokes.u8() * 0.01;
        strokes.u8(); strokes.u8(); strokes.i16(); strokes.i16();
        const expected = strokes.u8();
        const actual = checksum(payload.subarray(checksumStart, checksumStart + 15));
        if (actual !== expected) { this.warn(`Skipped a corrupt dot in offline packet ${packetId}`); continue; }
        points.push({ section, owner, note, page, timestampMs, x, y, pressure, color });
      }
      points.forEach((point, index) => dotEvents.push({
        type: "dot", origin: "offline",
        event: normalizedEvent(point, index === 0 ? "pen_down" : index === points.length - 1 ? "pen_up" : "pen_move", penId(this.info), sessionId, index + 1)
      }));
      if (points.length === 1 && points[0]) dotEvents.push({ type: "dot", origin: "offline", event: normalizedEvent(points[0], "pen_up", penId(this.info), sessionId, 2) });
    }
    this.background(this.persistAndAcknowledgeOfflinePacket(packetId, strokeCount, location, dotEvents), `Offline packet ${packetId} persistence`);
  }

  private async persistAndAcknowledgeOfflinePacket(packetId: number, strokeCount: number, location: number, events: readonly Extract<NeoProtocolEvent, { type: "dot" }>[]): Promise<void> {
    try {
      for (const event of events) await this.emit(event);
      await this.ackOfflinePacket(packetId, true);
      this.receivedOfflineStrokes += strokeCount;
      await this.emit({ type: "offline_progress", receivedStrokes: this.receivedOfflineStrokes, totalStrokes: this.totalOfflineStrokes });
      if (location === 2) await this.emit({ type: "offline_finished", success: true });
    } catch (error) {
      await this.ackOfflinePacket(packetId, false);
      await this.emit({ type: "offline_finished", success: false });
      throw error;
    }
  }

  private ackOfflinePacket(packetId: number, success: boolean): Promise<void> {
    return this.write(NEO_V2_COMMAND.OFFLINE_PACKET_RESPONSE, concat(int16(packetId), Uint8Array.of(1)), success ? 0 : 1);
  }
  private background(operation: Promise<void>, label: string): void {
    void operation.catch((error) => this.warn(`${label} failed: ${error instanceof Error ? error.message : String(error)}`));
  }
  private warn(message: string): void { this.emit({ type: "warning", message }); }
}

export class NeoFrameDecoder {
  private frame: number[] | undefined;
  private escaped = false;
  constructor(private readonly emit: (packet: Packet) => void, private readonly warn: (message: string) => void = () => undefined) {}
  push(chunk: Bytes): void {
    for (const byte of chunk) {
      if (byte === STX) { this.frame = []; this.escaped = false; continue; }
      if (!this.frame) continue;
      if (byte === ETX && !this.escaped) { this.finish(); continue; }
      if (this.escaped) { this.frame.push(byte ^ 0x20); this.escaped = false; continue; }
      if (byte === DLE) { this.escaped = true; continue; }
      this.frame.push(byte);
    }
  }
  private finish(): void {
    const bytes = Uint8Array.from(this.frame ?? []);
    this.frame = undefined;
    this.escaped = false;
    if (bytes.length < 3) { this.warn("Discarded a truncated Neo frame"); return; }
    let offset = 0;
    const command = bytes[offset++] ?? 0;
    const result = RESPONSE_COMMANDS.has(command) ? bytes[offset++] : undefined;
    const length = (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
    offset += 2;
    const actualLength = bytes.length - offset;
    if (actualLength !== length) {
      // Some protocol-2.20 pens report an outer length that differs from large
      // offline frames. The offline parser validates the declared data block,
      // decompressed size, stroke structure, and dot checksums instead.
      if (command !== NEO_V2_COMMAND.OFFLINE_PACKET_REQUEST) {
        this.warn(`Discarded Neo frame with declared length ${length} and actual length ${actualLength}`);
        return;
      }
    }
    this.emit({ command, ...(result === undefined ? {} : { result }), data: bytes.subarray(offset) });
  }
}

class Reader {
  offset = 0;
  constructor(private readonly data: Bytes) {}
  get remaining(): number { return this.data.length - this.offset; }
  u8(): number { this.ensure(1); return this.data[this.offset++] ?? 0; }
  i16(): number { this.ensure(2); const result = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 2).getInt16(0, true); this.offset += 2; return result; }
  u16(): number { this.ensure(2); const result = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 2).getUint16(0, true); this.offset += 2; return result; }
  i32(): number { this.ensure(4); const result = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 4).getInt32(0, true); this.offset += 4; return result; }
  i64(): bigint { this.ensure(8); const result = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 8).getBigInt64(0, true); this.offset += 8; return result; }
  bytes(length: number): Bytes { this.ensure(length); const result = this.data.subarray(this.offset, this.offset + length); this.offset += length; return result; }
  string(length: number): string { return new TextDecoder().decode(this.bytes(length)).replace(/\0+$/g, ""); }
  private ensure(length: number): void { if (this.remaining < length) throw new Error(`expected ${length} bytes, only ${this.remaining} remain`); }
}

function versionPayload(): Uint8Array { return concat(new Uint8Array(16), Uint8Array.of(0x12, 0x01), fixedString("0.2.0.0", 16), fixedString("2.12", 8)); }
function normalizedEvent(point: LastPoint, eventType: PenDotEvent["eventType"], id: string, sessionId: string, sequence: number): PenDotEvent {
  return {
    schemaVersion: PEN_EVENT_SCHEMA_VERSION, eventType, source: "native_bridge", sessionId, penId: id, sequence,
    timestampMs: point.timestampMs, notebookId: `NEO_${point.section}_${point.owner}_${point.note}`, pageId: point.page,
    x: point.x * NEO_TO_APP_PX, y: point.y * NEO_TO_APP_PX, pressure: point.pressure,
    ...(point.color && eventType === "pen_down" ? { color: point.color } : {}), coordinateSpace: "app_px"
  };
}
function neoColor(argb: number): string { return `#${(argb >>> 0 & 0xffffff).toString(16).padStart(6, "0")}`; }
function penId(info?: NeoDeviceInfo): string { return info?.macAddress.replaceAll(":", "") || "neo-unknown"; }
function sectionOwner(section: number, owner: number): Uint8Array { return Uint8Array.of(owner & 0xff, (owner >>> 8) & 0xff, (owner >>> 16) & 0xff, section & 0xff); }
function uint24(bytes: Bytes): number { return (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8) | ((bytes[2] ?? 0) << 16); }
function fixedString(value: string, length: number): Uint8Array { const result = new Uint8Array(length); result.set(new TextEncoder().encode(value).subarray(0, length)); return result; }
function uint16(value: number): Uint8Array { const result = new Uint8Array(2); new DataView(result.buffer).setUint16(0, value, true); return result; }
function int16(value: number): Uint8Array { const result = new Uint8Array(2); new DataView(result.buffer).setInt16(0, value, true); return result; }
function int32(value: number): Uint8Array { const result = new Uint8Array(4); new DataView(result.buffer).setInt32(0, value, true); return result; }
function concat(...chunks: readonly Bytes[]): Uint8Array { const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0)); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result; }
function checksum(bytes: Bytes): number { return bytes.reduce((sum, byte) => (sum + byte) & 0xff, 0); }
