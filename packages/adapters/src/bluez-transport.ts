import { Variant, systemBus, type ClientInterface, type MessageBus } from "dbus-next";
import { NEO_NOTIFY_UUIDS, NEO_SERVICE_UUIDS, NEO_WRITE_UUIDS, type DiscoveredPen, type NeoPenTransport } from "./neo-types.js";

type ManagedObjects = Record<string, Record<string, Record<string, Variant>>>;

export class BluezNeoTransport implements NeoPenTransport {
  private bus: MessageBus | undefined;
  private adapterPath: string | undefined;
  private adapterName: string | undefined;
  private activeDevicePath: string | undefined;
  private writeCharacteristic: ClientInterface | undefined;
  private notifyProperties: ClientInterface | undefined;
  private deviceProperties: ClientInterface | undefined;
  private dataCallback: (data: Uint8Array) => void = () => undefined;
  private disconnectCallback: (reason?: string) => void = () => undefined;
  private busErrorBound = false;
  private writeTail: Promise<void> = Promise.resolve();

  async initialize(): Promise<{ readonly adapterName: string }> {
    if (process.platform !== "linux") throw new Error("BlueZ transport is only available on Linux");
    try {
      this.bus ??= systemBus();
      if (!this.busErrorBound) {
        this.bus.on("error", (error: unknown) => this.disconnectCallback(`BlueZ D-Bus error: ${error instanceof Error ? error.message : String(error)}`));
        this.busErrorBound = true;
      }
      const objects = await this.managedObjects();
      const adapter = Object.entries(objects).find(([, interfaces]) => Boolean(interfaces["org.bluez.Adapter1"]));
      if (!adapter) throw new Error("BlueZ is running, but no Bluetooth adapter is visible");
      this.adapterPath = adapter[0];
      this.adapterName = stringProperty(adapter[1]["org.bluez.Adapter1"], "Alias") || adapter[0].split("/").at(-1) || "Bluetooth";
      return { adapterName: this.adapterName };
    } catch (error) {
      // A failed dbus-next connection cannot reliably recover in place. Drop it so
      // the next initialization creates a fresh system-bus connection.
      this.bus?.removeAllListeners("error");
      this.bus?.disconnect();
      this.bus = undefined;
      this.busErrorBound = false;
      this.adapterPath = undefined;
      this.adapterName = undefined;
      throw error;
    }
  }

  async scan(durationMs: number): Promise<readonly DiscoveredPen[]> {
    const adapterPath = this.requireAdapter();
    const object = await this.requireBus().getProxyObject("org.bluez", adapterPath);
    const adapter = object.getInterface("org.bluez.Adapter1");
    try {
      await adapter.SetDiscoveryFilter!({ Transport: new Variant("s", "le"), DuplicateData: new Variant("b", false) });
      await adapter.StartDiscovery!();
    } catch (error) {
      if (!dbusErrorContains(error, "InProgress")) throw error;
    }
    await delay(Math.max(1_000, Math.min(durationMs, 30_000)));
    try { await adapter.StopDiscovery!(); } catch (error) { if (!dbusErrorContains(error, "NotReady", "Failed")) throw error; }
    return this.devices();
  }

  async devices(): Promise<readonly DiscoveredPen[]> {
    const objects = await this.managedObjects();
    return Object.entries(objects)
      .filter(([path, interfaces]) => path.startsWith(this.requireAdapter()) && Boolean(interfaces["org.bluez.Device1"]))
      .map(([path, interfaces]) => deviceFromBluez(path, interfaces["org.bluez.Device1"] ?? {}))
      .filter((device) => device.neoCompatible)
      .sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
  }

  async connect(deviceId: string): Promise<void> {
    const devices = await this.devices();
    const device = devices.find((candidate) => candidate.deviceId === deviceId || candidate.address.toLowerCase() === deviceId.toLowerCase());
    if (!device) throw new Error(`Neo-compatible Bluetooth device not found: ${deviceId}`);
    const deviceObject = await this.requireBus().getProxyObject("org.bluez", device.deviceId);
    const deviceInterface = deviceObject.getInterface("org.bluez.Device1");
    this.deviceProperties = deviceObject.getInterface("org.freedesktop.DBus.Properties");
    this.deviceProperties.on("PropertiesChanged", (name: string, changed: Record<string, Variant>) => {
      if (name === "org.bluez.Device1" && changed.Connected?.value === false) this.disconnectCallback("Pen disconnected from BlueZ");
    });
    try { await deviceInterface.Connect!(); }
    catch (error) { if (!dbusErrorContains(error, "AlreadyConnected", "InProgress")) throw error; }
    this.activeDevicePath = device.deviceId;
    await this.waitForServices(device.deviceId);
    await this.bindCharacteristics(device.deviceId);
  }

  async disconnect(): Promise<void> {
    const path = this.activeDevicePath;
    this.writeCharacteristic = undefined;
    this.notifyProperties?.removeAllListeners("PropertiesChanged");
    this.notifyProperties = undefined;
    this.deviceProperties?.removeAllListeners("PropertiesChanged");
    this.deviceProperties = undefined;
    this.activeDevicePath = undefined;
    if (!path) return;
    try {
      const object = await this.requireBus().getProxyObject("org.bluez", path);
      await object.getInterface("org.bluez.Device1").Disconnect!();
    } catch (error) { if (!dbusErrorContains(error, "NotConnected", "UnknownObject")) throw error; }
  }

  write(data: Uint8Array): Promise<void> {
    const pending = this.writeTail.then(() => this.writeNow(data));
    // Keep the queue usable after a failed command while returning that failure to its caller.
    this.writeTail = pending.catch(() => undefined);
    return pending;
  }

  private async writeNow(data: Uint8Array): Promise<void> {
    const characteristic = this.writeCharacteristic;
    if (!characteristic) throw new Error("Neo write characteristic is not connected");
    // 20-byte chunks are safe before MTU negotiation and accepted by every supported generation.
    for (let offset = 0; offset < data.length; offset += 20) {
      const chunk = [...data.subarray(offset, offset + 20)];
      await retryInProgress(() => characteristic.WriteValue!(chunk, {}));
    }
  }

  onData(callback: (data: Uint8Array) => void): void { this.dataCallback = callback; }
  onDisconnect(callback: (reason?: string) => void): void { this.disconnectCallback = callback; }

  async dispose(): Promise<void> {
    try { await this.disconnect(); }
    finally {
      this.bus?.removeAllListeners("error");
      this.bus?.disconnect();
      this.bus = undefined;
      this.busErrorBound = false;
      this.adapterPath = undefined;
    }
  }

  private async bindCharacteristics(devicePath: string): Promise<void> {
    const objects = await this.managedObjects();
    const characteristics = Object.entries(objects).filter(([path, interfaces]) => path.startsWith(devicePath) && Boolean(interfaces["org.bluez.GattCharacteristic1"]));
    const write = characteristics.find(([, interfaces]) => NEO_WRITE_UUIDS.includes(uuidProperty(interfaces["org.bluez.GattCharacteristic1"]) as typeof NEO_WRITE_UUIDS[number]));
    const notify = characteristics.find(([, interfaces]) => NEO_NOTIFY_UUIDS.includes(uuidProperty(interfaces["org.bluez.GattCharacteristic1"]) as typeof NEO_NOTIFY_UUIDS[number]));
    if (!write || !notify) {
      const seen = characteristics.map(([, interfaces]) => uuidProperty(interfaces["org.bluez.GattCharacteristic1"])).filter(Boolean).join(", ");
      throw new Error(`Connected device does not expose Neo protocol-v2 GATT characteristics${seen ? ` (found: ${seen})` : ""}`);
    }
    const writeObject = await this.requireBus().getProxyObject("org.bluez", write[0]);
    this.writeCharacteristic = writeObject.getInterface("org.bluez.GattCharacteristic1");
    const notifyObject = await this.requireBus().getProxyObject("org.bluez", notify[0]);
    const notifyCharacteristic = notifyObject.getInterface("org.bluez.GattCharacteristic1");
    this.notifyProperties = notifyObject.getInterface("org.freedesktop.DBus.Properties");
    this.notifyProperties.on("PropertiesChanged", (name: string, changed: Record<string, Variant>) => {
      if (name !== "org.bluez.GattCharacteristic1") return;
      const value = changed.Value?.value as readonly number[] | Uint8Array | undefined;
      if (value) this.dataCallback(Uint8Array.from(value));
    });
    await retryInProgress(() => notifyCharacteristic.StartNotify!());
  }

  private async waitForServices(devicePath: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const objects = await this.managedObjects();
      const device = objects[devicePath]?.["org.bluez.Device1"];
      if (booleanProperty(device, "ServicesResolved")) return;
      await delay(250);
    }
    throw new Error("Timed out waiting for BlueZ to resolve the pen's GATT services");
  }

  private async managedObjects(): Promise<ManagedObjects> {
    const object = await this.requireBus().getProxyObject("org.bluez", "/");
    return await object.getInterface("org.freedesktop.DBus.ObjectManager").GetManagedObjects!() as ManagedObjects;
  }
  private requireBus(): MessageBus { if (!this.bus) throw new Error("BlueZ transport has not been initialized"); return this.bus; }
  private requireAdapter(): string { if (!this.adapterPath) throw new Error("No BlueZ Bluetooth adapter is available"); return this.adapterPath; }
}

function deviceFromBluez(path: string, properties: Record<string, Variant>): DiscoveredPen {
  const serviceUuids = arrayProperty(properties, "UUIDs").map(normalizeUuid);
  const name = stringProperty(properties, "Name") || stringProperty(properties, "Alias") || "Unknown pen";
  const address = stringProperty(properties, "Address") || path.split("/").at(-1)?.replace(/^dev_/, "").replaceAll("_", ":") || path;
  const rssi = numberProperty(properties, "RSSI");
  return {
    deviceId: path, address, name,
    ...(rssi === undefined ? {} : { rssi }),
    paired: booleanProperty(properties, "Paired"), connected: booleanProperty(properties, "Connected"), serviceUuids,
    neoCompatible: serviceUuids.some((uuid) => NEO_SERVICE_UUIDS.includes(uuid as typeof NEO_SERVICE_UUIDS[number])) || /neo|lamy|nwp-|smartpen/i.test(name)
  };
}

function unwrap(properties: Record<string, Variant> | undefined, key: string): unknown { return properties?.[key]?.value; }
function stringProperty(properties: Record<string, Variant> | undefined, key: string): string { const value = unwrap(properties, key); return typeof value === "string" ? value : ""; }
function numberProperty(properties: Record<string, Variant> | undefined, key: string): number | undefined { const value = unwrap(properties, key); return typeof value === "number" ? value : undefined; }
function booleanProperty(properties: Record<string, Variant> | undefined, key: string): boolean { return unwrap(properties, key) === true; }
function arrayProperty(properties: Record<string, Variant> | undefined, key: string): string[] { const value = unwrap(properties, key); return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function uuidProperty(properties: Record<string, Variant> | undefined): string { return normalizeUuid(stringProperty(properties, "UUID")); }
function normalizeUuid(uuid: string): string { const lower = uuid.toLowerCase(); return /^[0-9a-f]{4}$/.test(lower) ? `0000${lower}-0000-1000-8000-00805f9b34fb` : lower; }
function dbusErrorContains(error: unknown, ...fragments: readonly string[]): boolean {
  const candidate = error as { readonly type?: unknown; readonly text?: unknown; readonly message?: unknown };
  const message = [candidate?.type, candidate?.text, candidate?.message, String(error)].filter((value) => typeof value === "string").join(" ");
  const normalized = message.toLowerCase().replace(/[^a-z0-9]/g, "");
  return fragments.some((fragment) => normalized.includes(fragment.toLowerCase().replace(/[^a-z0-9]/g, "")));
}
async function retryInProgress<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= 5 || !dbusErrorContains(error, "InProgress")) throw error;
      await delay(50 * (attempt + 1));
    }
  }
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
