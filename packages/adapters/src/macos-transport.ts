import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { NEO_NOTIFY_UUIDS, NEO_SERVICE_UUIDS, NEO_WRITE_UUIDS, type DiscoveredPen, type NeoPenTransport } from "./neo-types.js";

const VERSION = 1;
const MAX_LINE_BYTES = 1_048_576;
const nativeDevices = z.object({ devices: z.array(z.object({
  deviceId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i), name: z.string().max(1000), rssi: z.number().finite(),
  serviceUuids: z.array(z.string()), connected: z.boolean()
})) });
const initialized = z.object({ adapterName: z.string().min(1) });
const empty = z.object({});
const response = z.discriminatedUnion("ok", [
  z.object({ version: z.literal(VERSION), id: z.number().int().positive(), ok: z.literal(true), result: z.unknown() }),
  z.object({ version: z.literal(VERSION), id: z.number().int().positive(), ok: z.literal(false), error: z.string() })
]);
const notification = z.discriminatedUnion("event", [
  z.object({ version: z.literal(VERSION), event: z.literal("data"), connectionId: z.string(), data: z.string().min(1).max(100_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }),
  z.object({ version: z.literal(VERSION), event: z.literal("disconnected"), connectionId: z.string(), reason: z.string() }),
  z.object({ version: z.literal(VERSION), event: z.literal("fatal"), error: z.string() })
]);
type PendingRequest = { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> };
export type MacosTransportOptions = {
  readonly helperPath?: string;
  /** Dependency injection for deterministic tests; never invokes Bluetooth. */
  readonly spawnHelper?: () => ChildProcessWithoutNullStreams;
  readonly timeoutMs?: number;
};

/** Core Bluetooth bytes over a private child-process pipe. No browser or socket. */
export class MacosNeoTransport implements NeoPenTransport {
  readonly initializationTimeoutMs = 65_000;
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private connectionId: string | undefined;
  private writeTail: Promise<void> = Promise.resolve();
  private dataCallback: (data: Uint8Array) => void = () => undefined;
  private disconnectCallback: (reason?: string) => void = () => undefined;

  constructor(private readonly options: MacosTransportOptions = {}) {}

  async initialize(): Promise<{ readonly adapterName: string }> {
    this.ensureHelper();
    return this.result(initialized, await this.request("initialize", {
      serviceUuids: NEO_SERVICE_UUIDS, writeUuids: NEO_WRITE_UUIDS, notifyUuids: NEO_NOTIFY_UUIDS,
      nameFragments: ["neo", "lamy", "nwp-", "smartpen"]
    }, 60_000));
  }

  async devices(): Promise<readonly DiscoveredPen[]> { return this.deviceResult(await this.request("devices")); }

  async scan(durationMs: number): Promise<readonly DiscoveredPen[]> {
    if (!Number.isFinite(durationMs)) throw new Error("Scan duration must be finite");
    const duration = Math.round(Math.max(1000, Math.min(durationMs, 30_000)));
    return this.deviceResult(await this.request("scan", { durationMs: duration }, duration + 5000));
  }

  async connect(deviceId: string): Promise<void> {
    if (this.connectionId) throw new Error("A Bluetooth connection is already active or pending");
    const connectionId = randomUUID();
    this.connectionId = connectionId;
    try {
      this.result(empty, await this.request("connect", { deviceId, connectionId }, 30_000));
      if (this.connectionId !== connectionId) throw new Error("Bluetooth connection was cancelled");
    } catch (error) {
      if (this.connectionId === connectionId) this.connectionId = undefined;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    // Invalidate queued frames and late native notifications before cancelling.
    this.connectionId = undefined;
    if (this.child) this.result(empty, await this.request("disconnect"));
  }

  write(data: Uint8Array): Promise<void> {
    const connectionId = this.connectionId;
    // Copy now: callers may reuse their packet buffer while this frame queues.
    const encoded = Buffer.from(data).toString("base64");
    const task = this.writeTail.then(async () => {
      if (!connectionId || connectionId !== this.connectionId) throw new Error("Pen is not connected");
      if (!data.length || data.length > 65536) throw new Error("Bluetooth frame must contain 1–65536 bytes");
      this.result(empty, await this.request("write", { connectionId, data: encoded }, 15_000));
    });
    this.writeTail = task.catch(() => undefined);
    return task;
  }

  onData(callback: (data: Uint8Array) => void): void { this.dataCallback = callback; }
  onDisconnect(callback: (reason?: string) => void): void { this.disconnectCallback = callback; }

  async dispose(): Promise<void> {
    const child = this.child;
    if (child) this.fail(child, new Error("macOS Bluetooth helper closed"), false);
  }

  private deviceResult(value: unknown): readonly DiscoveredPen[] {
    return this.result(nativeDevices, value).devices.map((device) => ({
      ...device,
      // Core Bluetooth exposes an opaque peripheral UUID, not its MAC address.
      // Canonical pen identity still comes from the shared Neo VERSION response.
      address: device.deviceId, paired: false, neoCompatible: true
    }));
  }

  private result<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    const error = new Error("macOS Bluetooth helper returned an invalid result; rebuild it with pnpm build:macos");
    if (this.child) this.fail(this.child, error);
    throw error;
  }

  private ensureHelper(): void {
    if (this.child) return;
    let child: ChildProcessWithoutNullStreams;
    try {
      if (this.options.spawnHelper) child = this.options.spawnHelper();
      else {
        if (process.platform !== "darwin") throw new Error("Core Bluetooth transport is only available on macOS");
        const executable = this.options.helperPath ?? process.env.INKRELAY_MACOS_BLUETOOTH_HELPER
          ?? resolve(process.cwd(), "native/macos/.build/InkRelayBluetooth.app/Contents/MacOS/InkRelayBluetooth");
        child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      }
    } catch (error) { throw new Error(`Could not launch macOS Bluetooth helper: ${error instanceof Error ? error.message : String(error)}`); }
    this.child = child;
    let buffered = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
    child.stdout.on("data", (chunk: string) => {
      if (this.child !== child) return;
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) { this.fail(child, new Error("Oversized Bluetooth bridge message")); return; }
        this.receive(child, line);
        if (this.child !== child) return;
      }
      if (Buffer.byteLength(buffered) > MAX_LINE_BYTES) this.fail(child, new Error("Oversized Bluetooth bridge message"));
    });
    child.on("error", (error) => this.fail(child, new Error(`Cannot start macOS Bluetooth helper: ${error.message}. Run pnpm build:macos first.`)));
    child.stdin.on("error", (error) => this.fail(child, new Error(`macOS Bluetooth pipe failed: ${error.message}`)));
    child.on("exit", (code, signal) => this.fail(child, new Error(`macOS Bluetooth helper stopped (${signal ?? code ?? "unknown"})${stderr ? `: ${stderr.trim()}` : ""}`)));
  }

  private request(command: string, payload: Readonly<Record<string, unknown>> = {}, timeoutMs = 4500): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("macOS Bluetooth has not been initialized"));
    const id = ++this.nextId;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        // Terminate on timeout, rather than allowing a late connection or write
        // to complete after the caller has moved on to a different pen session.
        this.fail(child, new Error(`macOS Bluetooth ${command} timed out. Allow any Bluetooth permission prompt, then Retry Bluetooth.`));
      }, this.options.timeoutMs ?? timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      child.stdin.write(JSON.stringify({ version: VERSION, id, command, ...payload }) + "\n", (error) => {
        if (error) this.fail(child, new Error(`macOS Bluetooth pipe failed: ${error.message}`));
      });
    });
  }

  private receive(child: ChildProcessWithoutNullStreams, line: string): void {
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { this.fail(child, new Error("Invalid Bluetooth bridge JSON")); return; }
    const parsedResponse = response.safeParse(value);
    if (parsedResponse.success) {
      const message = parsedResponse.data;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.ok) request.resolve(message.result);
      else request.reject(new Error(message.error));
      return;
    }
    const parsedNotification = notification.safeParse(value);
    if (!parsedNotification.success) { this.fail(child, new Error("Invalid Bluetooth bridge protocol message")); return; }
    const message = parsedNotification.data;
    if (message.event === "fatal") { this.fail(child, new Error(message.error)); return; }
    if (message.connectionId !== this.connectionId) return;
    if (message.event === "data") this.dataCallback(Uint8Array.from(Buffer.from(message.data, "base64")));
    else {
      this.connectionId = undefined;
      this.disconnectCallback(message.reason);
    }
  }

  private fail(child: ChildProcessWithoutNullStreams, error: Error, notify = true): void {
    if (this.child !== child) return;
    this.child = undefined;
    const connected = this.connectionId !== undefined;
    this.connectionId = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    child.stdin.end();
    child.kill();
    if (notify && connected) this.disconnectCallback(error.message);
  }
}
