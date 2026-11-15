import type { PenDotEvent } from "@inkrelay/core";

export const NEO_SERVICE_UUIDS = [
  "4f99f138-9d53-5bfa-9e50-b147491afe68",
  "000019f1-0000-1000-8000-00805f9b34fb"
] as const;

export const NEO_WRITE_UUIDS = [
  "8bc8cc7d-88ca-56b0-af9a-9bf514d0d61a",
  "00002ba0-0000-1000-8000-00805f9b34fb"
] as const;

export const NEO_NOTIFY_UUIDS = [
  "64cd86b1-2256-5aeb-9f04-2caf6c60ae57",
  "00002ba1-0000-1000-8000-00805f9b34fb"
] as const;

export type DiscoveredPen = {
  readonly deviceId: string;
  readonly address: string;
  readonly name: string;
  readonly rssi?: number;
  readonly paired: boolean;
  readonly connected: boolean;
  readonly serviceUuids: readonly string[];
  readonly neoCompatible: boolean;
};

export type NeoDeviceInfo = {
  readonly deviceName: string;
  readonly firmwareVersion: string;
  readonly protocolVersion: string;
  readonly subName: string;
  readonly deviceType: number;
  readonly macAddress: string;
  readonly pressureSensorType: number;
};

export type NeoPenStatus = {
  readonly locked: boolean;
  readonly passwordMaxRetries: number;
  readonly passwordRetries: number;
  readonly timestampMs: number;
  readonly autoPowerOffMinutes: number;
  readonly maxForce: number;
  readonly usedStoragePercent: number;
  readonly batteryPercent: number;
  readonly offlineDataEnabled: boolean;
  readonly hoverEnabled: boolean;
};

export type NeoOfflineNote = {
  readonly section: number;
  readonly owner: number;
  readonly note: number;
  readonly pages?: readonly number[];
};

export type PenConnectionState = "disconnected" | "connecting" | "negotiating" | "password_required" | "connected" | "disconnecting" | "error";

export type PenManagerSnapshot = {
  readonly bluetooth: {
    readonly available: boolean;
    readonly adapterName?: string;
    readonly scanning: boolean;
    readonly error?: string;
  };
  readonly devices: readonly DiscoveredPen[];
  readonly connection: PenConnectionState;
  readonly selectedDeviceId?: string;
  readonly deviceInfo?: NeoDeviceInfo;
  readonly penStatus?: NeoPenStatus;
  readonly offlineNotes: readonly NeoOfflineNote[];
  readonly sync: {
    readonly active: boolean;
    readonly completedNotes: number;
    readonly totalNotes: number;
    readonly receivedStrokes: number;
    readonly totalStrokes: number;
    readonly importedStrokes: number;
    readonly duplicateStrokes: number;
    readonly finishedAtMs?: number;
    readonly error?: string;
  };
};

export interface NeoPenTransport {
  readonly initializationTimeoutMs?: number;
  initialize(): Promise<{ readonly adapterName: string }>;
  scan(durationMs: number): Promise<readonly DiscoveredPen[]>;
  devices(): Promise<readonly DiscoveredPen[]>;
  connect(deviceId: string): Promise<void>;
  disconnect(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  onData(callback: (data: Uint8Array) => void): void;
  onDisconnect(callback: (reason?: string) => void): void;
  dispose?(): Promise<void>;
}

export type NeoProtocolEvent =
  | { readonly type: "device_info"; readonly info: NeoDeviceInfo }
  | { readonly type: "status"; readonly status: NeoPenStatus }
  | { readonly type: "authenticated" }
  | { readonly type: "password_required"; readonly retries: number; readonly maxRetries: number }
  | { readonly type: "password_rejected"; readonly retries: number; readonly maxRetries: number }
  | { readonly type: "dot"; readonly origin: "live" | "offline"; readonly event: PenDotEvent }
  | { readonly type: "offline_notes"; readonly notes: readonly NeoOfflineNote[]; readonly completeList: boolean }
  | { readonly type: "offline_started"; readonly totalStrokes: number; readonly totalBytes: number }
  | { readonly type: "offline_progress"; readonly receivedStrokes: number; readonly totalStrokes: number }
  | { readonly type: "offline_finished"; readonly success: boolean }
  | { readonly type: "battery_low"; readonly batteryPercent: number }
  | { readonly type: "warning"; readonly message: string };
