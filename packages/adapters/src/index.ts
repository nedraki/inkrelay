import { readFile } from "node:fs/promises";
import type { PenDotEvent } from "@inkrelay/core";
import { penDotEventSchema } from "@inkrelay/core";

export interface PenInputAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onDot(callback: (event: PenDotEvent) => void | Promise<void>): void;
}

abstract class BaseAdapter implements PenInputAdapter {
  protected callback?: (event: PenDotEvent) => void | Promise<void>;
  protected connected = false;
  async connect(): Promise<void> { this.connected = true; }
  async disconnect(): Promise<void> { this.connected = false; }
  onDot(callback: (event: PenDotEvent) => void | Promise<void>): void { this.callback = callback; }
  protected async emit(event: PenDotEvent): Promise<void> {
    if (!this.connected) throw new Error("Pen adapter is not connected");
    if (!this.callback) throw new Error("No onDot callback registered");
    await this.callback(event);
  }
}

export class MockPenAdapter extends BaseAdapter {
  async send(events: readonly PenDotEvent[]): Promise<void> {
    for (const event of events) await this.emit(penDotEventSchema.parse(event));
  }
}

export type ReplayOptions = { readonly realtime?: boolean; readonly speed?: number };

export class ReplayPenAdapter extends BaseAdapter {
  constructor(private readonly input: string | readonly PenDotEvent[], private readonly options: ReplayOptions = {}) { super(); }

  async replay(): Promise<number> {
    const events = typeof this.input === "string" ? await readJsonl(this.input) : [...this.input];
    let previous: PenDotEvent | undefined;
    for (const raw of events) {
      const event = penDotEventSchema.parse(raw);
      if (this.options.realtime && previous) await delay(Math.max(0, event.timestampMs - previous.timestampMs) / (this.options.speed ?? 1));
      await this.emit(event); // The original source is deliberately preserved.
      previous = event;
    }
    return events.length;
  }
}

export class WebBluetoothNeoAdapter extends BaseAdapter {
  override async connect(): Promise<void> {
    throw new Error("WebBluetoothNeoAdapter is a placeholder; production Neo BLE support is not implemented");
  }
}

export * from "./neo-types.js";
export * from "./neo-protocol-v2.js";
export * from "./bluez-transport.js";
export * from "./macos-transport.js";
export * from "./native-transport.js";
export * from "./neo-pen-manager.js";

async function readJsonl(path: string): Promise<PenDotEvent[]> {
  const content = await readFile(path, "utf8");
  return content.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return penDotEventSchema.parse(JSON.parse(line)); }
    catch (error) { throw new Error(`Invalid replay event at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
  });
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
export { parseNeoPaperDefinition, MAX_NPROJ_BYTES } from "./neo-paper.js";
export { NEO_PAPER_REFERENCES } from "./neo-paper-references.js";
