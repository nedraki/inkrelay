import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { InkRelayEngine } from "./engine.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const engine = new InkRelayEngine(config);
await engine.initialize();
const content = await readFile(resolve(process.cwd(), "fixtures/sample-session.events.jsonl"), "utf8");
const events = content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);
const ingestion = await engine.ingestMany(events);
const output = await engine.export("NB01", 12);
process.stdout.write(`${JSON.stringify({ ingestion, output, state: engine.snapshot().state }, null, 2)}\n`);
