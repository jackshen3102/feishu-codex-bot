import { Store } from "../src/db/store.js";
import fs from "node:fs/promises";
import path from "node:path";
import { createWebFixture } from "./web-fixture-data.js";
import { startWebServer } from "../src/web/server.js";

const args = process.argv.slice(2).filter(v => v !== "--");
if (args.length !== 4 || args[0] !== "--port" || args[2] !== "--state-dir" || !/^\d+$/.test(args[1] || "") || Number(args[1]) < 1 || Number(args[1]) > 65535 || !path.isAbsolute(args[3] || "")) throw new Error("Usage: web:fixture -- --port PORT --state-dir ABSOLUTE_EMPTY_DIRECTORY");
const fixture = await createWebFixture(args[3]!, `http://localhost:${Number(args[1])}`);
const store = new Store(fixture.databasePath, path.join(fixture.directory, "topics"));
try {
  const server = await startWebServer({ config: { host: "127.0.0.1", port: Number(args[1]) }, databasePath: fixture.databasePath, oncall: fixture.config, maxConcurrentTurns: 5, agentControl: { get: () => store.getAgentSettings(), set: value => store.setAgentSettings(value) } });
  await fs.writeFile(path.join(fixture.directory, "fixture.json"), JSON.stringify({ port: server.port, pid: process.pid }), { mode: 0o600 });
  console.log(JSON.stringify({ url: `http://localhost:${server.port}`, stateDirectory: fixture.directory, browserConfig: path.join(fixture.directory, "browser.config.json") }));
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; void server.close().finally(() => { store.close(); fixture.db.close(); }).catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch (error) { store.close(); fixture.db.close(); throw error; }
