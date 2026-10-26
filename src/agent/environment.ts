import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { loadOncallConfig } from "../oncall/workspace-config.js";

export function safeProxyEnvironment(): Record<string, string> {
  const proxyEnvironment: Record<string, string> = {};
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY"] as const) {
    const value = process.env[name];
    if (!value) continue;
    let proxy: URL;
    try {
      proxy = new URL(value);
    } catch {
      throw new Error(`Unsafe ${name} configuration`);
    }
    if (
      !["http:", "https:"].includes(proxy.protocol) ||
      proxy.username || proxy.password || proxy.search || proxy.hash ||
      (proxy.pathname !== "" && proxy.pathname !== "/")
    ) {
      throw new Error(`Unsafe ${name} configuration`);
    }
    proxyEnvironment[name] = value;
  }
  if (process.env.NO_PROXY) proxyEnvironment.NO_PROXY = process.env.NO_PROXY;
  return proxyEnvironment;
}

export function buildCommonAgentEnvironment(config: AppConfig): Record<string, string> {
  const locale = process.env.LC_ALL ?? process.env.LANG ?? "C.UTF-8";
  return {
    ...(config.ONCALL_CONFIG_PATH ? loadOncallConfig(config.ONCALL_CONFIG_PATH).agentEnvironment : {}),
    PATH: process.env.PATH ?? "",
    HOME: path.dirname(config.CODEX_HOME),
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    LANG: locale,
    LC_ALL: locale,
    ...safeProxyEnvironment(),
  };
}
