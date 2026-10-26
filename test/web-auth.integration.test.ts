import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWebFixture } from "../scripts/web-fixture-data.js";
import { loadWebConfig, startStandaloneWeb, startWebServer, WebError, type WebAuthentication } from "../src/web/index.js";
import { tempConfig, removeTemp } from "./helpers.js";

describe("independent Web authentication integration", () => {
  it("fails closed when an authenticated entrypoint has no integration", async () => {
    expect(() => loadWebConfig({ WEB_ENABLED: "true", WEB_SSO_ENABLED: "true" })).toThrow();
    await expect(startWebServer({ config: { host: "127.0.0.1", port: 0, authenticationRequired: true },
      databasePath: "/does-not-exist.db", oncall: {} as any, maxConcurrentTurns: 5 })).rejects.toThrow("authentication is required");
  });

  it("keeps verification, email authorization and settings permissions at the integration boundary", async () => {
    const { root } = await tempConfig();
    const fixture = await createWebFixture(path.join(root, "fixture"));
    let writes = 0;
    const authentication: WebAuthentication = {
      publicOrigin: "https://management.example.com", allowedEmails: ["owner@example.com"],
      sessionModule: path.resolve("src/web/public/session.js"),
      verify: async req => {
        if (!["owner", "stranger"].includes(String(req.headers["x-test-identity"]))) throw new WebError(401, "unauthorized", "身份未验证");
        return { email: req.headers["x-test-identity"] === "owner" ? "owner@example.com" : "stranger@example.com", username: "Fixture", avatarUrl: null };
      },
    };
    const options = { config: { host: "127.0.0.1" as const, port: 0 }, authentication,
      databasePath: fixture.databasePath, oncall: fixture.config, maxConcurrentTurns: 5,
      agentControl: { get: () => ({ backend: "codex" as const, model: null }), set: () => { writes++; return { backend: "codex" as const, model: null }; } } };
    const server = await startWebServer(options);
    let standalone: Awaited<ReturnType<typeof startStandaloneWeb>> | undefined;
    try {
      const base = `http://localhost:${server.port}`;
      expect((await fetch(base + "/api/oncall/workspaces", { headers: { "x-user-email": "owner@example.com" } })).status).toBe(401);
      expect((await fetch(base + "/api/oncall/workspaces", { headers: { "x-test-identity": "stranger" } })).status).toBe(403);
      expect((await fetch(base + "/api/oncall/workspaces", { headers: { "x-test-identity": "owner" } })).status).toBe(200);
      const body = JSON.stringify({ backend: "codex", model: null });
      expect((await fetch(base + "/api/oncall/agent-settings", { method: "PUT", body, headers: { "x-test-identity": "owner", "content-type": "application/json", origin: "https://foreign.example" } })).status).toBe(403);
      expect(writes).toBe(0);
      expect((await fetch(base + "/api/oncall/agent-settings", { method: "PUT", body, headers: { "x-test-identity": "owner", "content-type": "application/json", origin: base } })).status).toBe(200);
      expect(writes).toBe(1);
      standalone = await startStandaloneWeb(options);
      const standaloneBase = `http://localhost:${standalone.port}`;
      const bootstrap = await (await fetch(standaloneBase + "/api/oncall/auth-config")).json() as any;
      expect(bootstrap).toMatchObject({ enabled: true, agentSettingsAvailable: false });
      expect((await fetch(standaloneBase + "/api/oncall/agent-settings", { method: "PUT", body, headers: { "x-test-identity": "owner", "content-type": "application/json", origin: standaloneBase } })).status).toBe(405);
      expect(writes).toBe(1);
    } finally {
      await standalone?.close(); await server.close(); fixture.db.close(); await removeTemp(root);
    }
  });
});
