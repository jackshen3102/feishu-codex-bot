import type { AppConfig } from "../config.js";
import { CodexRunner, createCodexClients } from "../codex/runner.js";
import type { TurnRunner } from "./runner.js";

export function createTurnRunner(config: AppConfig): TurnRunner {
  return new CodexRunner({ timeoutMs: config.TURN_TIMEOUT_MS, ...createCodexClients(config) });
}
