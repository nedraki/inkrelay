import { BluezNeoTransport } from "./bluez-transport.js";
import { MacosNeoTransport } from "./macos-transport.js";
import type { DiscoveredPen, NeoPenTransport } from "./neo-types.js";

/** Select bytes-only OS transport; all pen protocol logic remains shared. */
export function createNativeNeoTransport(platform: NodeJS.Platform = process.platform): NeoPenTransport {
  if (platform === "linux") return new BluezNeoTransport();
  if (platform === "darwin") return new MacosNeoTransport();
  return new UnsupportedNeoTransport(platform);
}

export class UnsupportedNeoTransport implements NeoPenTransport {
  constructor(private readonly platform: string) {}
  async initialize(): Promise<{ adapterName: string }> { throw this.unavailable(); }
  async scan(_durationMs: number): Promise<readonly DiscoveredPen[]> { throw this.unavailable(); }
  async devices(): Promise<readonly DiscoveredPen[]> { return []; }
  async connect(_deviceId: string): Promise<void> { throw this.unavailable(); }
  async disconnect(): Promise<void> {}
  async write(_data: Uint8Array): Promise<void> { throw this.unavailable(); }
  onData(_callback: (data: Uint8Array) => void): void {}
  onDisconnect(_callback: (reason?: string) => void): void {}
  private unavailable(): Error { return new Error(`Native pen Bluetooth is not implemented for ${this.platform}. Linux (BlueZ) and macOS (Core Bluetooth) are supported; replay, storage and export remain available without Bluetooth.`); }
}
