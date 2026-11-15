import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app } = await createApp(config);

try { await app.listen({ port: config.port, host: config.host }); }
catch (error) { app.log.error(error); await app.close(); process.exitCode = 1; }

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void app.close().catch((error: unknown) => { app.log.error(error); process.exitCode = 1; }); });
}
