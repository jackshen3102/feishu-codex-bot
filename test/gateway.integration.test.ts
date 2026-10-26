import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { startOptionalWeb } from "../src/web/lifecycle.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Gateway } from "../src/gateway.js";
import { healthStatusPath } from "../src/health.js";
import { removeTemp, tempConfig } from "./helpers.js";

const gatewaySpies = vi.hoisted(() => ({
  webSocketStarts: 0,
  webSocketCloses: 0,
}));

vi.mock("../src/agent/factory.js", () => ({
  createTurnRunner: () => ({
    run: async () => ({ status: "succeeded", reply: "unused" }),
    abort: () => false,
    abortAll: () => undefined,
  }),
}));

vi.mock("../src/feishu/client.js", () => ({
  createLarkClient: () => ({}),
  resolveBotOpenId: async () => "bot-open-id",
  FeishuWebSocket: class {
    async start(): Promise<void> {
      gatewaySpies.webSocketStarts += 1;
    }

    close(): void {
      gatewaySpies.webSocketCloses += 1;
    }
  },
}));

describe("Gateway lifecycle", () => {
  afterEach(() => {
    gatewaySpies.webSocketStarts = 0;
    gatewaySpies.webSocketCloses = 0;
  });

  it("owns startup, health transitions, and idempotent shutdown without a real Feishu connection", async () => {
    const { config, root } = await tempConfig();
    let gateway: Gateway | null = null;
    try {
      gateway = await Gateway.create(config);
      await gateway.start();
      expect(gatewaySpies.webSocketStarts).toBe(1);
      await expect(fs.readFile(healthStatusPath(config.STATE_DB_PATH), "utf8")).resolves.toContain('"state":"running"');

      await gateway.stop();
      await gateway.stop();
      expect(gatewaySpies.webSocketCloses).toBe(1);
      await expect(fs.readFile(healthStatusPath(config.STATE_DB_PATH), "utf8")).resolves.toContain('"state":"stopped"');
    } finally {
      await gateway?.stop();
      await removeTemp(root);
    }
  });
});

// Real HTTP lifecycle around the existing fake Feishu adapter. No second gateway
// client, external message or Codex turn is created by management queries.
describe("Optional management Web lifecycle", () => {
  afterEach(() => {
    gatewaySpies.webSocketStarts = 0;
    gatewaySpies.webSocketCloses = 0;
  });

  async function setup() {
    const fixture = await tempConfig();
    fixture.config.ONCALL_CONFIG_PATH = path.join(fixture.root, "oncall.json");
    await fs.writeFile(fixture.config.ONCALL_CONFIG_PATH, JSON.stringify({
      workspaces: [{ id: "infra", knowledgePaths: [], repositories: [] }],
      groupBindings: [], privateBinding: { chatId: "private-chat", ownerOpenId: "owner", workspaceId: "infra" },
    }));
    const gateway = await Gateway.create(fixture.config);
    await gateway.start();
    return { ...fixture, gateway };
  }

  it("keeps Web disabled unless explicitly enabled", async () => {
    const f = await setup();
    try {
      expect(await startOptionalWeb(f.config, {})).toBeNull();
      expect(gatewaySpies.webSocketStarts).toBe(1);
      expect(gatewaySpies.webSocketCloses).toBe(0);
      expect(await fs.readFile(healthStatusPath(f.config.STATE_DB_PATH), "utf8")).toContain('"state":"running"');
    } finally { await f.gateway.stop(); await removeTemp(f.root); }
  });

  it.each(["configuration", "port"])("isolates %s startup failure from the running gateway", async (kind) => {
    const f = await setup();
    const occupied = http.createServer();
    occupied.listen(0, "127.0.0.1");
    await once(occupied, "listening");
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("fixture port unavailable");
    try {
      expect(await startOptionalWeb(f.config, {
        WEB_ENABLED: "true", WEB_PORT: kind === "configuration" ? "invalid" : String(address.port),
      })).toBeNull();
      expect(gatewaySpies.webSocketStarts).toBe(1);
      expect(gatewaySpies.webSocketCloses).toBe(0);
      expect(await fs.readFile(healthStatusPath(f.config.STATE_DB_PATH), "utf8")).toContain('"state":"running"');
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
      await f.gateway.stop(); await removeTemp(f.root);
    }
  });

  it("closes its HTTP resources before the normal gateway shutdown", async () => {
    const f = await setup();
    const reservation = http.createServer();
    reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("fixture port unavailable");
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const web = await startOptionalWeb(f.config, { WEB_ENABLED: "true", WEB_PORT: String(address.port) });
    try {
      expect(web).not.toBeNull();
      const endpoint = `http://localhost:${web!.port}/api/oncall/workspaces`;
      const response = await fetch(endpoint);
      expect(response.status).toBe(200);
      expect(gatewaySpies.webSocketStarts).toBe(1);
      await web!.close(); await web!.close();
      await expect(fetch(endpoint)).rejects.toThrow();
      await f.gateway.stop();
      expect(gatewaySpies.webSocketCloses).toBe(1);
      expect(await fs.readFile(healthStatusPath(f.config.STATE_DB_PATH), "utf8")).toContain('"state":"stopped"');
    } finally { await web?.close(); await f.gateway.stop(); await removeTemp(f.root); }
  });
});
