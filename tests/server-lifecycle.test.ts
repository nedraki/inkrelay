import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../apps/server/src/app.js";

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); });

it("closes persistent SSE clients so shutdown can release the native transport", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkrelay-shutdown-"));
  const created = await createApp({ canonicalDataPath: join(root, "raw"), vaultPath: join(root, "vault"),
    actionZonesPath: resolve("config/action-zones.json"), port: 0, host: "127.0.0.1", pythonServiceUrl: "http://127.0.0.1:8321",
    languageWorkerUrl: "http://127.0.0.1:8321", languageReviewTimeoutMs: 100, bluetoothEnabled: false });
  app = created.app;
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const request = get(`${address}/api/events`);
  const [response] = await once(request, "response");
  expect(response.headers["content-type"]).toBe("text/event-stream");
  const ended = once(response, "end");
  let received = "";
  response.on("data", (chunk: Buffer) => { received += chunk.toString("utf8"); });
  await created.engine.updateInkStyle({ width: 3 });
  await vi.waitFor(() => expect(received).toContain('"currentWidth":3'));
  await app.close();
  await ended;
});
