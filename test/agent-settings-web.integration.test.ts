import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createWebFixture } from "../scripts/web-fixture-data.js";
import { Store } from "../src/db/store.js";
import { startWebServer } from "../src/web/server.js";

it("restricts model settings writes to same-origin local JSON requests and persists valid settings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oncall-settings-"));
  const fixture = await createWebFixture(root);
  const store = new Store(fixture.databasePath, path.join(root, "topics"));
  const server = await startWebServer({ config: { host: "127.0.0.1", port: 0 }, databasePath: fixture.databasePath, oncall: fixture.config, maxConcurrentTurns: 5, agentControl: { get: () => store.getAgentSettings(), set: settings => store.setAgentSettings(settings) } });
  const base = `http://localhost:${server.port}`;
  const endpoint = base + "/api/oncall/agent-settings";
  const headers = { Origin: base, "Content-Type": "application/json" };
  const settings = { backend: "traex", model: "test-model" };
  try {
    expect((await fetch(endpoint)).status).toBe(200);
    for (const extra of [{ Origin: "https://foreign.example" }, { Origin: "" }, { "Content-Type": "text/plain" }]) expect((await fetch(endpoint, { method: "PUT", headers: { ...headers, ...extra }, body: JSON.stringify(settings) })).status).toBe(403);
    for (const input of [{ backend: "unknown", model: null }, { ...settings, password: "ignored?" }, { backend: "codex", model: "invalid model\n" }]) expect((await fetch(endpoint, { method: "PUT", headers, body: JSON.stringify(input) })).status).toBe(400);
    expect((await fetch(endpoint, { method: "PUT", headers, body: "{broken" })).status).toBe(400);
    expect((await fetch(endpoint, { method: "PUT", headers, body: " ".repeat(1025) })).status).toBe(413);
    expect(store.getAgentSettings()).toEqual({ backend: "codex", model: null });
    expect((await fetch(endpoint, { method: "PUT", headers, body: JSON.stringify(settings) })).status).toBe(200);
    expect(await (await fetch(endpoint)).json()).toEqual(settings);
    expect((await fetch(base + "/api/oncall/topics?workspaceId=infra", { method: "PUT", headers, body: "{}" })).status).toBe(405);
    expect((await fetch(endpoint, { method: "DELETE", headers })).status).toBe(405);
    expect((await fetch(endpoint + "?workspaceId=infra")).status).toBe(400);
    expect(store.getAgentSettings()).toEqual(settings);
  } finally { await server.close(); store.close(); fixture.db.close(); await fs.rm(root, { recursive: true, force: true }); }
});
