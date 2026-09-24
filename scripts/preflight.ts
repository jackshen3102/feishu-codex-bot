import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { ConfigError, loadConfig, type AppConfig } from "../src/config.js";
import { buildCodexEnvironment, createCodexClients, resolveBundledCodexRuntime } from "../src/codex/runner.js";
import { Store } from "../src/db/store.js";
import { createLarkClient, resolveBotOpenId } from "../src/feishu/client.js";
import { WorkspaceManager } from "../src/workspaces.js";

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

async function checkCodex(config: AppConfig): Promise<void> {
  await check("codex_login", () => run(
    resolveBundledCodexRuntime().binary,
    ["login", "status"],
    buildCodexEnvironment(config),
  ));
  await check("codex_sdk", async () => {
    const workspace = await fs.mkdtemp(path.join(config.WORKSPACE_ROOT, ".preflight-codex-"));
    try {
      const clients = createCodexClients(config);
      for (const smoke of [
        { client: clients.sandboxedCodex, sandboxMode: "read-only" as const },
        { client: clients.unrestrictedCodex, sandboxMode: "danger-full-access" as const },
      ]) {
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
          const turn = await thread.run("Use no tools. Return the required JSON only.", {
            signal: controller.signal,
            outputSchema: {
              type: "object", additionalProperties: false, required: ["ok"],
              properties: { ok: { type: "boolean", const: true } },
            },
          });
          if ((JSON.parse(turn.finalResponse) as { ok?: unknown }).ok !== true) {
            throw new Error("invalid Codex smoke response");
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

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  if (args.length > 1 || (args.length === 1 && args[0] !== "--codex-only")) {
    throw new Error("unsupported preflight arguments");
  }
  const config = loadConfig();
  if (args[0] === "--codex-only") {
    await checkCodex(config);
    process.stdout.write("preflight passed: Codex login and SDK calls\n");
    return;
  }
  await check("filesystem", () => Promise.all([
    config.CODEX_HOME, config.WORKSPACE_ROOT, path.dirname(config.STATE_DB_PATH),
  ].map(assertWritable)));
  await check("sqlite", async () => {
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    store.close();
  });
  await check("workspace_template", async () => {
    const workspaces = new WorkspaceManager(config.WORKSPACE_ROOT, path.join(process.cwd(), "workspace-template"));
    await workspaces.initialize();
  });
  await checkCodex(config);
  const client = createLarkClient(config);
  await check("feishu", async () => {
    await resolveBotOpenId(client);
    const [group, privateChat] = await Promise.all([
      client.im.v1.chat.get({ path: { chat_id: config.FEISHU_CHAT_ID } }),
      client.im.v1.chat.get({ path: { chat_id: config.FEISHU_PRIVATE_CHAT_ID } }),
    ]);
    if ((group.code ?? 0) !== 0 || group.data?.chat_mode !== "group") throw new Error("target group is unavailable");
    if ((privateChat.code ?? 0) !== 0 || privateChat.data?.chat_mode !== "p2p") throw new Error("target private chat is unavailable");
  });
  process.stdout.write("preflight passed: filesystem, SQLite, Codex, Feishu bot and target chats\n");
}

try {
  await main();
} catch (error) {
  const message = error instanceof ConfigError || error instanceof PreflightError ? error.message : "preflight failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
