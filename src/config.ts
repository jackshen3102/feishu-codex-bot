import path from "node:path";
import { z } from "zod";

const normalizedAbsolutePath = z.string().min(1).superRefine((value, context) => {
  if (!path.isAbsolute(value)) {
    context.addIssue({ code: "custom", message: "must be an absolute path" });
    return;
  }
  if (value.includes("\0") || path.resolve(value) !== value || value === path.parse(value).root) {
    context.addIssue({ code: "custom", message: "must be normalized and cannot be a filesystem root" });
  }
});

function isWithinOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

const configSchema = z.object({
  AGENT_BACKEND: z.literal("codex").default("codex"),
  FEISHU_APP_ID: z.string().min(1),
  FEISHU_APP_SECRET: z.string().min(1),
  FEISHU_CHAT_ID: z.string().min(1),
  FEISHU_PRIVATE_CHAT_ID: z.string().min(1),
  CODEX_HOME: normalizedAbsolutePath,
  STATE_DB_PATH: normalizedAbsolutePath,
  WORKSPACE_ROOT: normalizedAbsolutePath,
  MAX_CONCURRENT_TURNS: z.coerce.number().int().min(1),
  TURN_TIMEOUT_MS: z.coerce.number().int().min(60_000),
  WORKSPACE_RETENTION_DAYS: z.coerce.number().int().min(1),
  JOB_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
}).superRefine((value, context) => {
  if (value.FEISHU_CHAT_ID === value.FEISHU_PRIVATE_CHAT_ID) {
    context.addIssue({ code: "custom", path: ["FEISHU_PRIVATE_CHAT_ID"], message: "must differ from FEISHU_CHAT_ID" });
  }
  if (value.STATE_DB_PATH === value.CODEX_HOME || value.STATE_DB_PATH === value.WORKSPACE_ROOT) {
    context.addIssue({ code: "custom", path: ["STATE_DB_PATH"], message: "must name a file" });
  }
  if (isWithinOrEqual(value.WORKSPACE_ROOT, value.CODEX_HOME) || isWithinOrEqual(value.CODEX_HOME, value.WORKSPACE_ROOT)) {
    context.addIssue({ code: "custom", path: ["WORKSPACE_ROOT"], message: "must not overlap CODEX_HOME" });
  }
  if (isWithinOrEqual(value.WORKSPACE_ROOT, value.STATE_DB_PATH)) {
    context.addIssue({ code: "custom", path: ["STATE_DB_PATH"], message: "must be outside WORKSPACE_ROOT" });
  }
});

export type AgentBackend = "codex";
export type AppConfig = z.infer<typeof configSchema>;
export type CodexAppConfig = AppConfig;

export class ConfigError extends Error {
  readonly variables: string[];

  constructor(variables: string[]) {
    super(`Invalid configuration: ${variables.join(", ")}`);
    this.name = "ConfigError";
    this.variables = variables;
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = configSchema.safeParse(environment);
  if (result.success) return result.data;
  const variables = [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "configuration")))];
  throw new ConfigError(variables);
}

export function activeAgentHome(config: AppConfig): string {
  return config.CODEX_HOME;
}

export function containsProtectedCredential(config: AppConfig, value: string): boolean {
  return value.includes(config.FEISHU_APP_SECRET);
}
