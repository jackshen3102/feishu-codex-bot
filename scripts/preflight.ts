import { buildTraexEnvironment, createTraexClients } from "../src/agent/factory.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { ConfigError, loadConfig, traexHome, type AgentBackend, type AppConfig } from "../src/config.js";
import { buildCodexEnvironment, createCodexClients, resolveBundledCodexRuntime } from "../src/codex/runner.js";
import { Store } from "../src/db/store.js";
import { createLarkClient, resolveBotOpenId } from "../src/feishu/client.js";
import { WorkspaceManager } from "../src/workspaces.js";
import { loadOncallConfig, type OncallConfig } from "../src/oncall/workspace-config.js";

class PreflightError extends Error {
  constructor(readonly stage: string) {
    super(`preflight failed: ${stage}`);
    this.name = "PreflightError";
  }
}

async function check<T>(stage: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch {
    throw new PreflightError(stage);
  }
}

function run(command: string, args: string[], environment: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`${command} timed out`));
    }, 30_000);
    child.stdout.resume();
    child.stderr.resume();
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish(code === 0 ? undefined : new Error(`${command} exited nonzero`)));
  });
}

async function assertWritable(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const testPath = path.join(directory, `.preflight-${process.pid}`);
  await fs.writeFile(testPath, "", { mode: 0o600, flag: "wx" });
  await fs.unlink(testPath);
}

async function checkAgent(config: AppConfig, backend: AgentBackend): Promise<void> {
  await check(`${backend}_login`, () => run(
    backend === "codex" ? resolveBundledCodexRuntime().binary : config.TRAEX_BINARY ?? "traex",
    ["login", "status"],
    backend === "codex" ? buildCodexEnvironment(config) : buildTraexEnvironment(config),
  ));
  await check(`${backend}_sdk`, async () => {
    const workspace = await fs.mkdtemp(path.join(config.WORKSPACE_ROOT, `.preflight-${backend}-`));
    try {
      const clients = backend === "codex" ? createCodexClients(config) : createTraexClients(config);
      const modes = [
        { client: clients.sandboxedCodex, sandboxMode: "read-only" as const },
        { client: clients.unrestrictedCodex, sandboxMode: "danger-full-access" as const },
      ];
      for (const smoke of config.ONCALL_CONFIG_PATH ? modes.slice(1) : modes) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120_000);
        try {
          const thread = smoke.client.startThread({
            threadSource: "feishu-codex-bot",
            sandboxMode: smoke.sandboxMode,
            workingDirectory: workspace,
            skipGitRepoCheck: true,
            networkAccessEnabled: false,
            webSearchMode: "disabled",
            approvalPolicy: "never",
          });
          const turn = await thread.run("Use the shell command tool once to execute printf 'oncall-preflight-ok'. Do not read files or use other tools. Return the required JSON with ok=true only after the command succeeds.", {
            signal: controller.signal,
            outputSchema: {
              type: "object", additionalProperties: false, required: ["ok"],
              properties: { ok: { type: "boolean", const: true } },
            },
          });
          if ((JSON.parse(turn.finalResponse) as { ok?: unknown }).ok !== true) {
            throw new Error("invalid agent smoke response");
          }
          if (!turn.items.some((item) => item.type === "command_execution" && item.exit_code === 0 && item.aggregated_output.includes("oncall-preflight-ok"))) {
            throw new Error("Agent shell tool did not complete");
          }
        } finally {
          clearTimeout(timeout);
        }
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
}

const probe = z.object({ command: z.string().min(1), args: z.array(z.string()).default([]) });
const toolChecksSchema = z.array(z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  available: probe,
  login: probe,
  resource: probe,
}));

async function checkTools(file: string, config: AppConfig, oncall: OncallConfig | undefined, offline: boolean): Promise<void> {
  const probes = await check("tool_configuration", async () => toolChecksSchema.parse(JSON.parse(await fs.readFile(file, "utf8"))));
  const environment = { ...buildCodexEnvironment(config), ...oncall?.agentEnvironment };
  for (const tool of probes) {
    for (const stage of offline ? ["available"] as const : ["available", "login", "resource"] as const) {
      const invocation = tool[stage];
      await check(`tool_${tool.name}_${stage}`, () => run(invocation.command, invocation.args, environment));
      process.stdout.write(`preflight passed: tool ${tool.name} ${stage}\n`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  let offline = false;
  let agentOnly: AgentBackend | undefined;
  let toolsFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--offline") offline = true;
    else if (args[i] === "--codex-only") agentOnly = "codex";
    else if (args[i] === "--traex-only") agentOnly = "traex";
    else if (args[i] === "--tools" && args[i + 1] && !args[i + 1]!.startsWith("--")) toolsFile = args[++i];
    else throw new Error("unsupported preflight arguments");
  }
  if (offline && agentOnly) throw new Error("incompatible preflight arguments");
  const config = loadConfig();
  const backend = agentOnly ?? config.AGENT_BACKEND;
  const oncall = config.ONCALL_CONFIG_PATH
    ? await check("oncall_configuration", async () => loadOncallConfig(config.ONCALL_CONFIG_PATH!))
    : undefined;
  await check("filesystem", () => Promise.all([
    config.CODEX_HOME, traexHome(config), config.WORKSPACE_ROOT, path.dirname(config.STATE_DB_PATH),
  ].map(assertWritable)));
  await check("sqlite", async () => {
    const directory = await fs.mkdtemp(path.join(path.dirname(config.STATE_DB_PATH), ".preflight-sqlite-"));
    try {
      const store = new Store(path.join(directory, "state.db"), config.WORKSPACE_ROOT);
      store.close();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  await check("workspace_template", async () => {
    const workspaces = new WorkspaceManager(config.WORKSPACE_ROOT, path.join(process.cwd(), "workspace-template"));
    await workspaces.initialize();
  });
  if (oncall) {
    await check("oncall_resources", async () => {
      for (const workspace of oncall.workspaces) {
        for (const resource of [...workspace.knowledgePaths, ...workspace.repositories.flatMap((repo) => repo.sourcePath ? [repo.sourcePath] : [])]) {
          await fs.access(resource, fs.constants.R_OK);
        }
      }
    });
  }
  await check(`${backend}_binary`, () => run(backend === "codex" ? resolveBundledCodexRuntime().binary : config.TRAEX_BINARY ?? "traex", ["--version"], backend === "codex" ? buildCodexEnvironment(config) : buildTraexEnvironment(config)));
  if (toolsFile) await checkTools(toolsFile, config, oncall, offline);
  else process.stdout.write("preflight not checked: business tool login and target resource access (provide --tools file)\n");
  if (offline) {
    process.stdout.write("preflight passed: local configuration, filesystem, temporary SQLite, template and selected agent binary; remote access not checked\n");
    return;
  }
  await checkAgent(config, backend);
  if (agentOnly) {
    process.stdout.write(`preflight passed: local checks, ${backend} login and SDK shell execution; Feishu not checked\n`);
    return;
  }
  const client = createLarkClient(config);
  await check("feishu", async () => {
    await resolveBotOpenId(client);
    const groupIds = oncall ? oncall.groupBindings.map((binding) => binding.chatId) : [config.FEISHU_CHAT_ID];
    for (const chatId of groupIds) {
      const group = await client.im.v1.chat.get({ path: { chat_id: chatId } });
      if ((group.code ?? 0) !== 0 || group.data?.chat_mode !== "group") throw new Error("target group is unavailable");
    }
    const privateChat = await client.im.v1.chat.get({ path: { chat_id: oncall?.privateBinding.chatId ?? config.FEISHU_PRIVATE_CHAT_ID } });
    if ((privateChat.code ?? 0) !== 0 || privateChat.data?.chat_mode !== "p2p") throw new Error("target private chat is unavailable");
  });
  process.stdout.write(`preflight passed: filesystem, SQLite, ${backend}, Feishu bot and target chats\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof ConfigError || error instanceof PreflightError ? error.message : "preflight failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
