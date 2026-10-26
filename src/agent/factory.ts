import { Codex } from "@openai/codex-sdk";
import { fileURLToPath } from "node:url";
import { accessSync, constants, statSync } from "node:fs";
import { buildCommonAgentEnvironment } from "./environment.js";
import { CodexRunner, createCodexClients } from "../codex/runner.js";
import { traexHome, type AppConfig } from "../config.js";
import type { Store } from "../db/store.js";
import type { Job, Topic, TurnReply } from "../contracts.js";
import type { AgentSettings } from "./settings.js";
import type { AgentProgressReporter, TurnRunner } from "./runner.js";

export function buildTraexEnvironment(config: AppConfig): Record<string, string> {
  return {
    ...buildCommonAgentEnvironment(config),
    TRAE_HOME: traexHome(config),
    FEISHU_AGENT_BACKEND: "traex",
    FEISHU_CODEX_BINARY: config.TRAEX_BINARY ?? "traex",
  };
}

export function createTraexClients(config: AppConfig): ReturnType<typeof createCodexClients> {
  const environment = buildTraexEnvironment(config);
  const supervisor = fileURLToPath(new URL("../../scripts/codex-process-group.mjs", import.meta.url));
  const unrestrictedCodex = new Codex({ codexPathOverride: supervisor, env: environment });
  if (config.ONCALL_CONFIG_PATH) return { unrestrictedCodex, sandboxedCodex: unrestrictedCodex };
  const isolation = fileURLToPath(new URL("../../scripts/codex-isolated.sh", import.meta.url));
  return { unrestrictedCodex, sandboxedCodex: new Codex({ codexPathOverride: isolation, env: { ...environment, FEISHU_AGENT_SUPERVISOR: supervisor } }) };
}

export function assertTraexAvailable(config: AppConfig): void {
  // Resolve only executable files from the explicit path or the service PATH.
  const candidates = config.TRAEX_BINARY ? [config.TRAEX_BINARY] : (process.env.PATH ?? "").split(":").filter(Boolean).map(dir => `${dir}/traex`);
  if (!candidates.some(candidate => { try { accessSync(candidate, constants.X_OK); return statSync(candidate).isFile(); } catch { return false; } })) throw new Error("TRAE CLI is unavailable");
}

export class SwitchingRunner implements TurnRunner {
  private readonly active = new Map<number, TurnRunner>();
  constructor(private readonly store: Store, private readonly create: (settings: AgentSettings) => TurnRunner) {}

  async run(job: Job, topic: Topic, reportProgress?: AgentProgressReporter): Promise<TurnReply> {
    const settings = this.store.getAgentSettings();
    const runner = this.create(settings);
    this.active.set(job.id, runner);
    try {
      return await runner.run(job, { ...topic, agentSessionId: this.store.getBackendSession(topic.id, settings.backend) }, reportProgress,
        sessionId => this.store.setBackendSession(topic.id, settings.backend, sessionId));
    } finally { this.active.delete(job.id); }
  }
  abort(jobId: number): boolean { return this.active.get(jobId)?.abort(jobId) ?? false; }
  abortAll(): void { for (const runner of this.active.values()) runner.abortAll(); }
}

export function createTurnRunner(config: AppConfig, store: Store): TurnRunner {
  // Clients are initialized lazily so a missing optional CLI does not disable Codex.
  const clients = new Map<string, ReturnType<typeof createCodexClients>>();
  return new SwitchingRunner(store, settings => {
    let client = clients.get(settings.backend);
    if (!client) {
      if (settings.backend === "traex") assertTraexAvailable(config);
      client = settings.backend === "codex" ? createCodexClients(config) : createTraexClients(config);
      clients.set(settings.backend, client);
    }
    return new CodexRunner({ timeoutMs: config.TURN_TIMEOUT_MS, oncall: Boolean(config.ONCALL_CONFIG_PATH), model: settings.model, ...client });
  });
}
