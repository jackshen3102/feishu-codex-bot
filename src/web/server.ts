import { agentSettingsSchema, type AgentControl } from "../agent/settings.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { healthStatusPath, readHealthStatus } from "../health.js";
import { WebError, type ListQuery } from "./contracts.js";
import { WebReadModel } from "./read-model.js";
import type { WebConfig } from "./config.js";
import type { OncallConfig } from "../oncall/workspace-config.js";
import type { WebAuthentication, WebRequest } from "./auth.js";

export interface WebServer { port: number; close: () => Promise<void> }
export interface WebServerOptions {
  config: WebConfig;
  databasePath: string;
  oncall: OncallConfig;
  maxConcurrentTurns: number;
  publicDirectory?: string;
  agentControl?: AgentControl;
  authentication?: WebAuthentication;
}
function params(url: URL, allowed: string[]): URLSearchParams {
  const keys = [...url.searchParams.keys()];
  if (keys.some(k => !allowed.includes(k)) || new Set(keys).size !== keys.length) throw new WebError(400, "invalid_query", "查询参数无效");
  return url.searchParams;
}
function query(p: URLSearchParams, mode: "topics" | "cases" | "jobs"): ListQuery {
  const workspaceId = p.get("workspaceId") || "", q = p.get("q") || "", filter = p.get(mode === "cases" ? "verification" : "filter") || "all";
  const raw = p.get("limit") || "30", limit = Number(raw);
  if (!workspaceId || q.length > 200 || !/^\d+$/.test(raw) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
    !(mode === "cases" ? ["all", "verified"] : mode === "topics" ? ["all", "attention", "running", "succeeded"] : ["all"]).includes(filter)) throw new WebError(400, "invalid_query", "查询参数无效");
  return { workspaceId, q, filter, limit, ...(p.has("cursor") ? { cursor: p.get("cursor")! } : {}) };
}
function send(res: ServerResponse, status: number, body: unknown, head: boolean): void {
  res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(head ? undefined : JSON.stringify(body));
}
function requestOrigin(req: IncomingMessage, port: number, authentication?: WebAuthentication): string | null {
  const host = req.headers.host?.toLowerCase();
  const canonical = authentication?.publicOrigin;
  if (canonical && host === new URL(canonical).host) return canonical;
  const suffix = `:${port}`;
  if (!host?.endsWith(suffix)) return null;
  const hostname = host.slice(0, -suffix.length);
  // Runweave's iOS local preview forwards the original HTTP bytes under a
  // per-page preview-<uuid>.localhost host, preserving the service port.
  if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname) &&
    !(hostname.length <= 253 && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.localhost$/.test(hostname))) return null;
  return `http://${host}`;
}
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const authentication = options.authentication;
  if (options.config.authenticationRequired && !authentication) throw new Error("Web authentication is required");
  if (authentication) {
    const origin = new URL(authentication.publicOrigin);
    if ((origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) ||
        origin.origin !== authentication.publicOrigin || !authentication.allowedEmails.length) throw new Error("Invalid Web authentication configuration");
    if ((authentication.browserSources ?? []).some(source => !/^https:\/\/[^\s;'"]+$/.test(source))) throw new Error("Invalid authentication browser source");
  }
  const publicDirectory = options.publicDirectory || fileURLToPath(new URL("./public/", import.meta.url));
  const assets = new Map<string, { body: Buffer; type: string }>();
  for (const [route, file, type] of [["/", "index.html", "text/html"], ["/app.js", "app.js", "text/javascript"], ["/styles.css", "styles.css", "text/css"]]) {
    assets.set(route!, { body: await fs.readFile(path.join(publicDirectory, file!)), type: type! });
  }
  assets.set("/session.js", { body: await fs.readFile(authentication?.sessionModule ?? path.join(publicDirectory, "session.js")), type: "text/javascript" });
  for (const asset of authentication?.assets ?? []) {
    if (!/^\/[a-z0-9-]+\.js$/.test(asset.route) || assets.has(asset.route) || asset.type !== "text/javascript") throw new Error("Invalid authentication asset");
    assets.set(asset.route, { body: await fs.readFile(asset.file), type: asset.type });
  }
  const model = new WebReadModel(options.databasePath, options.oncall);
  let actualPort = options.config.port;
  const server = createServer((req, res) => {
    void handle(req as WebRequest, res).catch(() => { if (!res.headersSent) send(res, 503, { error: { code: "unavailable", message: "数据暂时不可用，请稍后重试" } }, req.method === "HEAD"); else res.end(); });
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 2000;
  async function handle(req: WebRequest, res: ServerResponse): Promise<void> {
    req.user = null;
    const head = req.method === "HEAD";
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("X-Frame-Options", "DENY");
    const browserSources = authentication?.browserSources?.length ? " " + authentication.browserSources.join(" ") : "";
    res.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'${browserSources}; frame-src 'self'${browserSources}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    const origin = requestOrigin(req, actualPort, authentication);
    const authenticationReturn = authentication && req.headers.host?.toLowerCase() === new URL(authentication.publicOrigin).host && req.method === "GET" && req.url?.split("?")[0] === "/" && req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "document";
    if (!origin || (req.headers.origin && req.headers.origin !== origin) || (req.headers["sec-fetch-site"] === "cross-site" && !authenticationReturn)) { send(res, 403, { error: { code: "forbidden", message: "不允许的访问来源" } }, head); return; }
    try {
      const url = new URL(req.url || "/", `http://localhost:${actualPort}`);
      let route: string;
      try { route = decodeURIComponent(url.pathname); } catch { throw new WebError(400, "invalid_path", "路径无效"); }
      const settingsRoute = route === "/api/oncall/agent-settings";
      if (!["GET", "HEAD"].includes(req.method || "") && !(req.method === "PUT" && settingsRoute && options.agentControl)) { res.setHeader("Allow", settingsRoute && options.agentControl ? "GET, HEAD, PUT" : "GET, HEAD"); throw new WebError(405, "method_not_allowed", "不支持此操作"); }
      const asset = assets.get(route);
      if (asset) { res.statusCode = 200; res.setHeader("Content-Type", `${asset.type}; charset=utf-8`); res.end(head ? undefined : asset.body); return; }
      if (route === "/api/oncall/auth-config") { params(url, []); send(res, 200, { ...authentication?.clientConfig, enabled: !!authentication, agentSettingsAvailable: !!options.agentControl, publicOrigin: authentication?.publicOrigin ?? null }, head); return; }
      if (!route.startsWith("/api/oncall/")) throw new WebError(404, "not_found", "页面不存在");
      if (authentication) req.user = await authentication.verify(req);
      const canManage = !authentication || !!req.user && authentication.allowedEmails.includes(req.user.email);
      if (route === "/api/oncall/me") { params(url, []); send(res, 200, { enabled: !!authentication, user: req.user, canManage }, head); return; }
      if (!canManage) throw new WebError(403, "access_denied", "当前账号暂无管理页访问权限");
      if (req.method === "PUT" && settingsRoute && options.agentControl) {
        params(url, []);
        // Require an exact same origin and JSON for the sole administrator write API.
        if (req.headers.origin !== origin || req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new WebError(403, "forbidden", "修改需要同源 JSON 请求");
        let raw = "";
        for await (const chunk of req) {
          raw += chunk.toString();
          if (Buffer.byteLength(raw) > 1024) throw new WebError(413, "too_large", "配置内容过长");
        }
        let input: unknown;
        try { input = JSON.parse(raw); } catch { throw new WebError(400, "invalid_settings", "模型配置无效"); }
        const parsed = agentSettingsSchema.safeParse(input);
        if (!parsed.success) throw new WebError(400, "invalid_settings", "请选择执行引擎，并填写有效模型 ID 或留空");
        let settings;
        try { settings = options.agentControl.set(parsed.data); } catch { throw new WebError(409, "settings_unavailable", "无法切换，请检查服务中的 CLI 安装及配置"); }
        send(res, 200, settings, false); return;
      }
      if (settingsRoute) {
        params(url, []);
        if (!options.agentControl) throw new WebError(503, "unavailable", "模型设置暂不可用");
        send(res, 200, options.agentControl.get(), head); return;
      }
      let body: unknown;
      if (route === "/api/oncall/workspaces") {
        params(url, []); body = { items: model.workspaces(), maxConcurrentTurns: options.maxConcurrentTurns };
      } else if (route === "/api/oncall/overview") {
        const p = params(url, ["workspaceId"]); const w = p.get("workspaceId"); if (!w) throw new WebError(400, "invalid_query", "缺少工作区");
        const metrics = model.overview(w, options.maxConcurrentTurns);
        let health: unknown = { sampleStatus: "unavailable" };
        try { const h = await readHealthStatus(healthStatusPath(options.databasePath)); health = { sampleStatus: h.sampleStatus, sampledAt: h.sampledAt, sampleAgeMs: h.sampleAgeMs, service: { state: h.service.state } }; } catch {/* Missing/stale health is independent of database readability. */ }
        body = { metrics, health, sampledAt: new Date().toISOString() };
      } else if (route === "/api/oncall/topics") {
        body = model.snapshot(() => model.topics(query(params(url, ["workspaceId", "q", "filter", "cursor", "limit"]), "topics")));
      } else if (route === "/api/oncall/cases") {
        body = model.snapshot(() => model.cases(query(params(url, ["workspaceId", "q", "verification", "cursor", "limit"]), "cases")));
      } else {
        const match = route.match(/^\/api\/oncall\/topics\/([^/]+)(?:\/jobs(?:\/(\d+))?)?$/);
        const caseMatch = route.match(/^\/api\/oncall\/cases\/([^/]+)$/);
        if (match) {
          const isJobs = route.endsWith("/jobs");
          const p = params(url, isJobs ? ["workspaceId", "cursor", "limit"] : ["workspaceId"]);
          const q = query(p, "jobs"), topicId = match[1]!;
          if (isJobs) body = model.jobs(q, topicId);
          else if (match[2]) { const id = Number(match[2]); if (!Number.isSafeInteger(id) || id < 1) throw new WebError(400, "invalid_query", "任务 ID 无效"); body = model.jobDetail(q.workspaceId, topicId, id); }
          else body = { topic: model.snapshot(() => model.topic(q.workspaceId, topicId)) };
        } else if (caseMatch) { const p = params(url, ["workspaceId"]), q = query(p, "jobs"); body = model.snapshot(() => model.case(q.workspaceId, caseMatch[1]!)); }
        else throw new WebError(404, "not_found", "接口不存在");
      }
      send(res, 200, body, head);
    } catch (error) {
      const problem = error instanceof WebError ? error : new WebError(503, "unavailable", "数据暂时不可用，请稍后重试");
      send(res, problem.status, { error: { code: problem.code, message: problem.message } }, head);
    }
  }
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.config.port, options.config.host, () => { server.off("error", reject); resolve(); }); });
    const address = server.address(); if (address && typeof address !== "string") actualPort = address.port;
  } catch (error) { model.close(); throw error; }
  let stopping: Promise<void> | undefined;
  return {
port: actualPort, close: () => stopping ??= (async () => {
      const timeout = setTimeout(() => server.closeAllConnections(), 2000); timeout.unref();
      try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } finally { clearTimeout(timeout); model.close(); }
    })()
};
}
