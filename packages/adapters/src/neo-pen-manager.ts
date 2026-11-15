import type { PenDotEvent } from "@inkrelay/core";
import { createNativeNeoTransport } from "./native-transport.js";
import { NeoProtocolV2 } from "./neo-protocol-v2.js";
import type { DiscoveredPen, NeoOfflineNote, NeoPenTransport, NeoProtocolEvent, PenConnectionState, PenManagerSnapshot } from "./neo-types.js";

export class NeoPenManager {
  private available = false;
  private adapterName: string | undefined;
  private bluetoothError: string | undefined;
  private scanning = false;
  private discovered: readonly DiscoveredPen[] = [];
  private connection: PenConnectionState = "disconnected";
  private selectedDeviceId: string | undefined;
  private protocol: NeoProtocolV2 | undefined;
  private deviceInfo: PenManagerSnapshot["deviceInfo"] | undefined;
  private penStatus: PenManagerSnapshot["penStatus"] | undefined;
  private offlineNotes: readonly NeoOfflineNote[] = [];
  private syncState: PenManagerSnapshot["sync"] = emptySyncState();
  private syncQueue: NeoOfflineNote[] = [];
  private syncRequested = false;
  private completedStrokeCount = 0;
  private currentNoteReceivedStrokes = 0;
  private readonly listeners = new Set<(snapshot: PenManagerSnapshot) => void>();

  constructor(
    private readonly onDot: (event: PenDotEvent) => void | { readonly accepted: boolean } | Promise<void | { readonly accepted: boolean }>,
    private readonly transport: NeoPenTransport = createNativeNeoTransport()
  ) {
    transport.onData((data) => this.protocol?.receive(data));
    transport.onDisconnect((reason) => {
      this.connection = "disconnected";
      this.protocol = undefined;
      if (this.syncState.active) this.failSync("The pen disconnected before offline synchronization finished");
      if (reason) this.bluetoothError = reason;
      this.emit();
    });
  }

  async initialize(): Promise<void> {
    try {
      const result = await withTimeout(this.transport.initialize(), this.transport.initializationTimeoutMs ?? 5_000, "Bluetooth adapter did not respond before the initialization deadline");
      this.available = true;
      this.adapterName = result.adapterName;
      this.bluetoothError = undefined;
      this.discovered = await withTimeout(this.transport.devices(), 5_000, "Bluetooth device list did not respond within 5 seconds");
    } catch (error) {
      this.available = false;
      this.bluetoothError = friendlyBluetoothError(error);
    }
    this.emit();
  }

  async scan(durationMs = 10_000): Promise<readonly DiscoveredPen[]> {
    if (!this.available) await this.initialize();
    if (!this.available) throw new Error(this.bluetoothError ?? "Bluetooth is unavailable");
    this.scanning = true;
    this.bluetoothError = undefined;
    this.emit();
    try { this.discovered = await this.transport.scan(durationMs); return this.discovered; }
    catch (error) { this.bluetoothError = friendlyBluetoothError(error); throw new Error(this.bluetoothError); }
    finally { this.scanning = false; this.emit(); }
  }

  async connect(deviceId: string): Promise<void> {
    if (this.connection !== "disconnected" && this.connection !== "error") throw new Error("A pen connection is already active");
    this.connection = "connecting";
    this.selectedDeviceId = deviceId;
    this.bluetoothError = undefined;
    this.offlineNotes = [];
    this.syncQueue = [];
    this.syncRequested = false;
    this.syncState = emptySyncState();
    this.emit();
    try {
      await this.transport.connect(deviceId);
      this.connection = "negotiating";
      this.protocol = new NeoProtocolV2((data) => this.transport.write(data), (event) => this.handleProtocolEvent(event));
      this.emit();
      await this.protocol.start();
    } catch (error) {
      this.connection = "error";
      this.bluetoothError = friendlyBluetoothError(error);
      this.emit();
      throw new Error(this.bluetoothError);
    }
  }

  async disconnect(): Promise<void> {
    this.connection = "disconnecting";
    this.emit();
    await this.transport.disconnect();
    this.connection = "disconnected";
    this.protocol = undefined;
    this.selectedDeviceId = undefined;
    this.emit();
  }

  async close(): Promise<void> {
    // Stop interpreting notifications before tearing down the native connection.
    this.protocol = undefined;
    if (this.transport.dispose) await this.transport.dispose();
    else await this.transport.disconnect();
  }

  async authenticate(password: string): Promise<void> {
    if (!this.protocol || this.connection !== "password_required") throw new Error("The connected pen is not requesting a password");
    await this.protocol.authenticate(password);
  }

  async refreshOfflineNotes(): Promise<void> {
    if (!this.protocol || this.connection !== "connected") throw new Error("Connect and authenticate a pen first");
    await this.protocol.requestOfflineNotes();
  }

  async syncAll(): Promise<void> {
    if (!this.protocol || this.connection !== "connected") throw new Error("Connect and authenticate a pen first");
    if (this.syncState.active) throw new Error("An offline sync is already running");
    this.syncRequested = true;
    this.syncQueue = [];
    this.completedStrokeCount = 0;
    this.currentNoteReceivedStrokes = 0;
    this.syncState = { ...emptySyncState(), active: true };
    this.emit();
    await this.protocol.requestOfflineNotes();
  }

  snapshot(): PenManagerSnapshot {
    return {
      bluetooth: { available: this.available, ...(this.adapterName ? { adapterName: this.adapterName } : {}), scanning: this.scanning, ...(this.bluetoothError ? { error: this.bluetoothError } : {}) },
      devices: this.discovered, connection: this.connection,
      ...(this.selectedDeviceId ? { selectedDeviceId: this.selectedDeviceId } : {}),
      ...(this.deviceInfo ? { deviceInfo: this.deviceInfo } : {}), ...(this.penStatus ? { penStatus: this.penStatus } : {}),
      offlineNotes: this.offlineNotes, sync: this.syncState
    };
  }
  subscribe(listener: (snapshot: PenManagerSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  private handleProtocolEvent(event: NeoProtocolEvent): void | Promise<void> {
    switch (event.type) {
      case "device_info": this.deviceInfo = event.info; break;
      case "status": this.penStatus = event.status; break;
      case "authenticated": this.connection = "connected"; break;
      case "password_required": this.connection = "password_required"; break;
      case "password_rejected": this.connection = "password_required"; this.bluetoothError = `Incorrect pen password (${event.retries}/${event.maxRetries} attempts used)`; break;
      case "dot": return this.ingestDot(event);
      case "offline_notes":
        this.offlineNotes = event.completeList ? replaceNotes(this.offlineNotes, event.notes) : mergeNotes(this.offlineNotes, event.notes);
        if (this.syncRequested && event.completeList) this.startSyncQueue(this.offlineNotes);
        break;
      case "offline_started": this.currentNoteReceivedStrokes = 0; this.syncState = { ...this.syncState, totalStrokes: this.syncState.totalStrokes + event.totalStrokes }; break;
      case "offline_progress": this.currentNoteReceivedStrokes = event.receivedStrokes; this.syncState = { ...this.syncState, receivedStrokes: this.completedStrokeCount + event.receivedStrokes }; break;
      case "offline_finished": this.finishCurrentNote(event.success); break;
      case "battery_low": if (this.penStatus) this.penStatus = { ...this.penStatus, batteryPercent: event.batteryPercent }; break;
      case "warning": this.bluetoothError = event.message; break;
    }
    this.emit();
  }

  private async ingestDot(event: Extract<NeoProtocolEvent, { type: "dot" }>): Promise<void> {
    try {
      const result = await this.onDot(event.event);
      if (event.origin === "offline" && event.event.eventType === "pen_down") {
        if (result && !result.accepted) this.syncState = { ...this.syncState, duplicateStrokes: this.syncState.duplicateStrokes + 1 };
        else this.syncState = { ...this.syncState, importedStrokes: this.syncState.importedStrokes + 1 };
      }
    } catch (error) {
      this.bluetoothError = `Event ingestion failed: ${error instanceof Error ? error.message : String(error)}`;
      this.emit();
      throw error;
    }
  }

  private startSyncQueue(notes: readonly NeoOfflineNote[]): void {
    if (!this.syncRequested || this.syncQueue.length > 0) return;
    this.syncQueue = [...notes];
    this.syncState = { ...this.syncState, totalNotes: notes.length };
    if (this.syncQueue.length === 0) {
      this.syncRequested = false;
      this.syncState = { ...this.syncState, active: false, finishedAtMs: Date.now() };
      this.emit();
      return;
    }
    this.requestOfflineData(this.syncQueue[0]!);
  }

  private finishCurrentNote(success: boolean): void {
    if (!this.syncState.active) return;
    if (!success) {
      this.failSync("The pen reported an offline transfer failure");
      return;
    }
    this.syncQueue.shift();
    this.completedStrokeCount += this.currentNoteReceivedStrokes;
    this.currentNoteReceivedStrokes = 0;
    const completedNotes = this.syncState.completedNotes + 1;
    if (this.syncQueue.length === 0) {
      this.syncRequested = false;
      this.syncState = { ...this.syncState, active: false, completedNotes, finishedAtMs: Date.now() };
    } else {
      this.syncState = { ...this.syncState, completedNotes };
      this.requestOfflineData(this.syncQueue[0]!);
    }
  }
  private requestOfflineData(note: NeoOfflineNote): void {
    void this.protocol?.requestOfflineData(note).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.failSync(`Offline transfer request failed: ${message}`);
      this.emit();
    });
  }
  private failSync(error: string): void {
    this.syncRequested = false;
    this.syncQueue = [];
    this.syncState = { ...this.syncState, active: false, error, finishedAtMs: Date.now() };
  }
  private emit(): void { const snapshot = this.snapshot(); for (const listener of this.listeners) listener(snapshot); }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    operation.then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error: unknown) => { clearTimeout(timeout); reject(error); }
    );
  });
}

function mergeNotes(existing: readonly NeoOfflineNote[], incoming: readonly NeoOfflineNote[]): NeoOfflineNote[] {
  const notes = new Map(existing.map((note) => [noteKey(note), note]));
  for (const note of incoming) notes.set(noteKey(note), note);
  return [...notes.values()].sort((a, b) => a.section - b.section || a.owner - b.owner || a.note - b.note);
}
function replaceNotes(existing: readonly NeoOfflineNote[], incoming: readonly NeoOfflineNote[]): NeoOfflineNote[] {
  const prior = new Map(existing.map((note) => [noteKey(note), note]));
  return incoming.map((note) => ({ ...note, ...(note.pages ? {} : prior.get(noteKey(note))?.pages ? { pages: prior.get(noteKey(note))!.pages } : {}) }))
    .sort((a, b) => a.section - b.section || a.owner - b.owner || a.note - b.note);
}
function emptySyncState(): PenManagerSnapshot["sync"] {
  return { active: false, completedNotes: 0, totalNotes: 0, receivedStrokes: 0, totalStrokes: 0, importedStrokes: 0, duplicateStrokes: 0 };
}
function noteKey(note: NeoOfflineNote): string { return `${note.section}:${note.owner}:${note.note}`; }
function friendlyBluetoothError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/system_bus_socket/i.test(message)) return "BlueZ system bus is not accessible from this process";
  if (/AccessDenied|NotAuthorized/i.test(message) || (/bluez|dbus|system.bus/i.test(message) && /permission/i.test(message))) return "Bluetooth access was denied; allow this process to use the BlueZ system bus";
  return message;
}
