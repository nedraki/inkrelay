// Synthetic JSONL peer for transport tests. Never accesses a Bluetooth adapter.
import { createInterface } from "node:readline";
const mode = process.argv[2] ?? "normal";
let connectionId;
const emit = (value) => process.stdout.write(JSON.stringify({ version: 1, ...value }) + "\n");
const success = (request, result = {}) => emit({ id: request.id, ok: true, result });
const device = { deviceId: "11111111-1111-A111-0111-111111111111", name: "LAMY synthetic", rssi: -40,
  connected: false, serviceUuids: ["4f99f138-9d53-5bfa-9e50-b147491afe68"] };
const input = createInterface({ input: process.stdin });
let writing = false;
let initializationAttempts = 0;
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (mode === "hang") return;
  if (mode === "malformed") { process.stdout.write("not-json\n"); return; }
  if (mode === "wrong-version") { process.stdout.write(JSON.stringify({ version: 2, id: request.id, ok: true, result: {} }) + "\n"); return; }
  if (mode === "oversized") { process.stdout.write("x".repeat(1_048_577)); return; }
  if (mode === "crash") { process.exit(7); }
  if (mode === "bad-result") { success(request, { devices: "bad" }); return; }
  if (mode === "deny-once" && request.command === "initialize" && ++initializationAttempts === 1) {
    emit({ id: request.id, ok: false, error: "Bluetooth permission denied" }); return;
  }
  if (mode === "denied") { emit({ id: request.id, ok: false, error: "Bluetooth permission denied" }); return; }
  switch (request.command) {
    case "initialize":
      if (!request.serviceUuids?.length || !request.writeUuids?.length || !request.notifyUuids?.length) throw new Error("Missing UUIDs");
      success(request, { adapterName: "Synthetic Core Bluetooth" });
      break;
    case "devices": case "scan": success(request, { devices: [device] }); break;
    case "connect":
      connectionId = request.connectionId;
      success(request);
      emit({ event: "data", connectionId: "stale", data: "AQID" });
      emit({ event: "data", connectionId, data: "BAUG" });
      break;
    case "disconnect": {
      const previous = connectionId;
      connectionId = undefined;
      success(request);
      emit({ event: "data", connectionId: previous, data: "Bw==" });
      emit({ event: "disconnected", connectionId: previous, reason: "Intentional disconnect" });
      break;
    }
    case "write":
      if (writing) { emit({ id: request.id, ok: false, error: "Concurrent write" }); return; }
      if (request.connectionId !== connectionId) { emit({ id: request.id, ok: false, error: "Stale connection" }); return; }
      if (mode === "write-crash") { process.exit(8); }
      if (mode === "write-invalid-data") { success(request); emit({ event: "data", connectionId, data: "invalid!" }); return; }
      if (mode === "disconnect-on-write") {
        emit({ event: "disconnected", connectionId, reason: "Synthetic radio lost" });
        connectionId = undefined;
        emit({ id: request.id, ok: false, error: "Radio lost" });
        return;
      }
      if (mode === "slow-write") {
        writing = true;
        setTimeout(() => { writing = false; success(request); }, 40);
      } else {
        writing = true;
        setTimeout(() => {
          writing = false;
          emit({ event: "data", connectionId, data: request.data });
          success(request);
        }, 5);
      }
      break;
  }
});
input.on("close", () => process.exit(0));
