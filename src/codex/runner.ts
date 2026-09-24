import { statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Codex, type Thread } from "@openai/codex-sdk";
import { buildCommonAgentEnvironment } from "../agent/environment.js";
import { FORMAT_CORRECTION_PROMPT, parseTurnReply, turnOutputSchema } from "../agent/output.js";
import { progressUpdateFromThreadEvent } from "../agent/progress.js";
import {
  AgentAuthenticationError,
  TurnTimeoutError,
  type AgentProgressReporter,
  type AgentSessionReporter,
  type TurnRunner,
} from "../agent/runner.js";
import type { CodexAppConfig } from "../config.js";
import type { Job, Topic, TurnReply } from "../contracts.js";

export interface CodexRunnerOptions {
  timeoutMs: number;
  codex?: Codex;
  sandboxedCodex?: Codex;
  unrestrictedCodex?: Codex;
}

interface BundledCodexRuntime {
  binary: string;
  pathDirectory: string;
}

const AUTHENTICATION_FAILURE_MARKERS = [
  "access token could not be refreshed",
  "authentication token is expired",
  "refresh_token_reused",
  "token_expired",
  "not logged in",
  "please run codex login",
  "missing bearer or basic authentication",
  "401 unauthorized",
  "invalid_api_key",
];

function classifyCodexError(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof AgentAuthenticationError) return error;
  const message = error.message.toLowerCase();
  return AUTHENTICATION_FAILURE_MARKERS.some((marker) => message.includes(marker))
    ? new AgentAuthenticationError()
    : error;
}

function codexStreamError(message: string, fallback: string): Error {
  const classified = classifyCodexError(new Error(message));
  return classified instanceof AgentAuthenticationError ? classified : new Error(fallback);
}

export function resolveBundledCodexRuntime(): BundledCodexRuntime {
  const runtimes: Record<string, { packageName: string; target: string }> = {
    "linux:x64": { packageName: "@openai/codex-linux-x64", target: "x86_64-unknown-linux-musl" },
    "linux:arm64": { packageName: "@openai/codex-linux-arm64", target: "aarch64-unknown-linux-musl" },
  };
  const selected = runtimes[`${process.platform}:${process.arch}`];
  if (!selected) throw new Error("Unsupported Codex service platform");

  const sdkRequire = createRequire(import.meta.resolve("@openai/codex-sdk"));
  const codexPackage = sdkRequire.resolve("@openai/codex/package.json");
  const codexRequire = createRequire(codexPackage);
  const platformPackageJson = codexRequire.resolve(`${selected.packageName}/package.json`);
  const vendorRoot = path.join(path.dirname(platformPackageJson), "vendor", selected.target);
  const binary = path.join(vendorRoot, "bin", "codex");
  const pathDirectory = path.join(vendorRoot, "codex-path");
  if (!statSync(binary).isFile() || !statSync(pathDirectory).isDirectory()) {
    throw new Error("Bundled Codex runtime is incomplete");
  }
  return { binary, pathDirectory };
}

export function buildCodexEnvironment(config: CodexAppConfig): Record<string, string> {
  const runtime = resolveBundledCodexRuntime();
  const common = buildCommonAgentEnvironment(config);
  return {
    ...common,
    PATH: [runtime.pathDirectory, common.PATH].filter(Boolean).join(path.delimiter),
    CODEX_HOME: config.CODEX_HOME,
    FEISHU_CODEX_BINARY: runtime.binary,
  };
}

export function createCodexClients(config: CodexAppConfig): {
  sandboxedCodex: Codex;
  unrestrictedCodex: Codex;
} {
  const runtime = resolveBundledCodexRuntime();
  const isolationWrapper = fileURLToPath(new URL("../../scripts/codex-isolated.sh", import.meta.url));
  return {
    sandboxedCodex: new Codex({ codexPathOverride: isolationWrapper, env: buildCodexEnvironment(config) }),
    unrestrictedCodex: new Codex({
      codexPathOverride: runtime.binary,
      env: buildCodexEnvironment(config),
    }),
  };
}

export class CodexRunner implements TurnRunner {
  private readonly active = new Map<number, AbortController>();

  constructor(private readonly options: CodexRunnerOptions) {}

  async run(
    job: Job,
    topic: Topic,
    reportProgress?: AgentProgressReporter,
    reportSession?: AgentSessionReporter,
  ): Promise<TurnReply> {
    if (!job.inputText) throw new Error("queued job has no input");
    const controller = new AbortController();
    this.active.set(job.id, controller);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs);

    try {
      const threadOptions = {
        threadSource: "feishu-codex-bot",
        sandboxMode: job.executionMode === "unrestricted" ? "danger-full-access" as const : "workspace-write" as const,
        workingDirectory: topic.workspacePath,
        skipGitRepoCheck: true,
        networkAccessEnabled: true,
        webSearchMode: "live" as const,
        approvalPolicy: "never" as const,
      };
      const codex = job.executionMode === "unrestricted"
        ? (this.options.unrestrictedCodex ?? this.options.codex)
        : (this.options.sandboxedCodex ?? this.options.codex);
      if (!codex) throw new Error("Codex client is unavailable");
      const thread = topic.agentSessionId
        ? codex.resumeThread(topic.agentSessionId, threadOptions)
        : codex.startThread(threadOptions);

      const firstResponse = await this.stream(thread, job.inputText, controller.signal, reportProgress, reportSession);
      try {
        return parseTurnReply(firstResponse);
      } catch {
        const correction = await this.stream(
          thread,
          FORMAT_CORRECTION_PROMPT,
          controller.signal,
          reportProgress,
          reportSession,
        );
        return parseTurnReply(correction);
      }
    } catch (error) {
      if (timedOut) {
        throw new TurnTimeoutError();
      }
      throw classifyCodexError(error);
    } finally {
      clearTimeout(timeout);
      this.active.delete(job.id);
    }
  }

  abort(jobId: number): boolean {
    const controller = this.active.get(jobId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  abortAll(): void {
    for (const controller of this.active.values()) controller.abort();
  }

  private async stream(
    thread: Thread,
    input: string,
    signal: AbortSignal,
    reportProgress?: AgentProgressReporter,
    reportSession?: AgentSessionReporter,
  ): Promise<string> {
    const streamed = await thread.runStreamed(input, { outputSchema: turnOutputSchema, signal });
    let lastAgentMessage: string | null = null;
    let completed = false;

    for await (const event of streamed.events) {
      if (event.type === "thread.started") reportSession?.(event.thread_id);
      const progress = progressUpdateFromThreadEvent(event);
      if (progress) reportProgress?.(progress);
      if (event.type === "item.completed" && event.item.type === "agent_message") {
        lastAgentMessage = event.item.text;
      } else if (event.type === "turn.completed") {
        completed = true;
      } else if (event.type === "turn.failed") {
        throw codexStreamError(event.error.message, "Codex turn failed");
      } else if (event.type === "error") {
        throw codexStreamError(event.message, "Codex stream failed");
      }
    }

    if (!completed || lastAgentMessage === null) throw new Error("Codex stream ended without a final response");
    return lastAgentMessage;
  }
}
