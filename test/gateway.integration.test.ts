import fs from "node:fs/promises";
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
