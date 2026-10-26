import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTurnRunner, SwitchingRunner } from "../src/agent/factory.js";
import { Store } from "../src/db/store.js";
import { deferred, FakeRunner, removeTemp, tempConfig, waitUntil } from "./helpers.js";

function enqueue(store: Store) {
  const accepted = store.acceptJob({ messageId: "request", chatId: "chat", requesterOpenId: "owner", allowNewTopic: true, newTopicInput: "test", existingTopicInput: "test" });
  if (!accepted.job) throw new Error("expected accepted job");
  return { job: accepted.job, topic: store.getTopic(accepted.job.topicId)! };
}

describe("administrator agent selection", () => {
  it("preserves in-flight selection, independent sessions and selection across restart", async () => {
    const { config, root } = await tempConfig();
    let store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    try {
      const { job, topic } = enqueue(store);
      store.setAgentSessionId(topic.id, "legacy-codex");
      const started = deferred(); const release = deferred();
      const choices: string[] = [], sessions: Array<string | null> = [];
      const switching = new SwitchingRunner(store, settings => {
        choices.push(`${settings.backend}/${settings.model}`);
        return { run: async (_job, selectedTopic, _progress, reportSession) => {
          sessions.push(selectedTopic.agentSessionId);
          if (choices.length === 1) { started.resolve(); await release.promise; }
          reportSession?.(selectedTopic.agentSessionId ?? "traex-session");
          return { status: "succeeded", reply: "ok" };
        }, abort: () => true, abortAll: () => release.resolve() };
      });
      const first = switching.run(job, topic); await started.promise;
      store.setAgentSettings({ backend: "traex", model: "test-model" });
      release.resolve(); await first;
      await switching.run(job, topic);
      store.setAgentSettings({ backend: "codex", model: null });
      await switching.run(job, topic);
      expect(choices).toEqual(["codex/null", "traex/test-model", "codex/null"]);
      expect(sessions).toEqual(["legacy-codex", null, "legacy-codex"]);
      store.setAgentSettings({ backend: "traex", model: "test-model" });
      store.close(); store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
      expect(store.getAgentSettings()).toEqual({ backend: "traex", model: "test-model" });
      expect(store.getBackendSession(topic.id, "traex")).toBe("traex-session");
      expect(store.getBackendSession(topic.id, "codex")).toBe("legacy-codex");
    } finally { store.close(); await removeTemp(root); }
  });

  it("routes cancellation to the original runner after switching", async () => {
    const { config, root } = await tempConfig(); const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const fake = new FakeRunner(); fake.block = true;
    try {
      const { job, topic } = enqueue(store); const runner = new SwitchingRunner(store, () => fake);
      const turn = runner.run(job, topic); await waitUntil(() => fake.calls.length === 1);
      store.setAgentSettings({ backend: "traex", model: null });
      expect(runner.abort(job.id)).toBe(true); await turn;
      expect(fake.abortCalls).toEqual([job.id]);
    } finally { fake.abortAll(); store.close(); await removeTemp(root); }
  });

  it("executes and resumes TRAE through the real SDK supervisor with an allowlisted environment", async () => {
    const { config, root } = await tempConfig(); const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    try {
      vi.stubEnv("FEISHU_APP_SECRET", config.FEISHU_APP_SECRET);
      vi.stubEnv("FEISHU_TENANT_TOKEN", "fixture-tenant-token");
      const record = path.join(root, "invocations.jsonl"), binary = path.join(root, "traex");
      await fs.writeFile(binary, `#!/usr/bin/env node\nconst fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args, home: process.env.TRAE_HOME, secret: Boolean(process.env.FEISHU_APP_SECRET), token: Boolean(process.env.FEISHU_TENANT_TOKEN) }) + '\\n');
process.stdin.resume(); process.stdin.on('end', () => {
for (const event of [{type:'thread.started',thread_id:'traex-session'}, {type:'item.completed',item:{id:'final',type:'agent_message',text:JSON.stringify({status:'succeeded',reply:'ok'})}}, {type:'turn.completed',usage:{input_tokens:1,output_tokens:1,cached_input_tokens:0}}]) console.log(JSON.stringify(event));
});`, { mode: 0o700 });
      config.TRAEX_BINARY = binary;
      const { job, topic } = enqueue(store);
      store.setAgentSessionId(topic.id, "codex-only-session");
      store.setAgentSettings({ backend: "traex", model: "test-model" });
      const runner = createTurnRunner(config, store);
      expect(await runner.run({ ...job, executionMode: "unrestricted" }, topic)).toEqual({ status: "succeeded", reply: "ok" });
      await runner.run({ ...job, executionMode: "unrestricted" }, topic);
      const calls = (await fs.readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(calls).toHaveLength(2);
      expect(calls[0].args).toContain("--no-daemon"); expect(calls[0].args).toContain("--json");
      expect(calls[0].args).not.toContain("--experimental-json"); expect(calls[0].args).not.toContain("--thread-source");
      expect(calls[0].args).toContain("test-model"); expect(calls[0].args).not.toContain("codex-only-session");
      expect(calls[1].args).toContain("resume"); expect(calls[1].args).toContain("traex-session");
      expect(calls[0].home).toBe(path.join(root, "traex"));
      expect(calls[0].secret).toBe(false); expect(calls[0].token).toBe(false);
    } finally { vi.unstubAllEnvs(); store.close(); await removeTemp(root); }
  });

  it("migrates existing v12 Codex sessions without resetting jobs", async () => {
    const { config, root } = await tempConfig(); let store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    try {
      const { job, topic } = enqueue(store); store.setAgentSessionId(topic.id, "preserved-session");
      store.database.exec("DROP TABLE topic_agent_sessions"); store.database.pragma("user_version = 12");
      store.close(); store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
      expect(store.getBackendSession(topic.id, "codex")).toBe("preserved-session");
      expect(store.getBackendSession(topic.id, "traex")).toBeNull();
      expect(store.getJob(job.id)?.executionStatus).toBe("queued");
    } finally { store.close(); await removeTemp(root); }
  });
});
