import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import type { OncallConfig } from "../src/oncall/workspace-config.js";

export async function createWebFixture(directory: string, evidenceOrigin = "http://localhost:6193") {
  if (!path.isAbsolute(directory)) throw new Error("Fixture directory must be absolute");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await fs.readdir(directory)).length) throw new Error("Fixture directory must be empty");
  const databasePath = path.join(directory, "bot.db");
  const db = new Database(databasePath);
  try {
    db.pragma("journal_mode = WAL");
    db.exec(await fs.readFile(new URL("../src/db/schema.sql", import.meta.url), "utf8"));
    db.pragma("user_version = 13");
    const now = new Date().toISOString(), old = new Date(Date.now() - 3600000).toISOString();
    const config: OncallConfig = { workspaces: [{ id: "infra", knowledgePaths: ["/knowledge/repositories.md"], repositories: [{ name: "基础设施", url: "https://git.example.com/team/infra.git", description: "业务资料关联", defaultRef: "main" }] }, { id: "other", knowledgePaths: [], repositories: [] }, { id: "empty", knowledgePaths: [], repositories: [] }], groupBindings: [{ chatId: "fixture-group", workspaceId: "infra" }, { chatId: "fixture-other-group", workspaceId: "other" }], privateBinding: { chatId: "fixture-private", ownerOpenId: "fixture-owner", workspaceId: "infra" }, maxAttachmentBytes: 20971520, agentEnvironment: { BUSINESS_TOOL_PROFILE: "not-for-browser" } };
    const addTopic = (id: string, title: string, workspace = "infra", paused = false, hasRoot = true) => {
      const chat = workspace === "other" ? "fixture-other-group" : id === "topic-snapshot" ? "fixture-private" : "fixture-group";
      db.prepare("INSERT INTO topics(id,workspace_path,created_at,last_active_at) VALUES(?,?,?,?)").run(id, path.join(directory, id), old, now);
      db.prepare("INSERT INTO oncall_topics(topic_id,workspace_id,chat_id,root_id,owner_open_id,paused,pause_reason) VALUES(?,?,?,?,?,?,?)").run(id, workspace, chat, 'root-' + id, "fixture-owner", paused ? 1 : 0, paused ? "user_stopped" : null);
      if (hasRoot) db.prepare("INSERT INTO oncall_messages(message_id,chat_id,root_id,sender,content_json,received_at) VALUES(?,?,?,?,?,?)").run('root-' + id, chat, 'root-' + id, "fixture-owner", JSON.stringify({ text: title }), old);
    };
    const addJob = (topic: string, id: number, status: string, result: string | null, states: string[] = [], content: unknown = { text: "请结合当前记录分析问题。" }) => {
      const row = db.prepare("SELECT chat_id,root_id FROM oncall_topics WHERE topic_id=?").get(topic) as { chat_id: string; root_id: string };
      const stamp = id < 103 ? old : now;
      db.prepare("INSERT INTO jobs(id,feishu_message_id,topic_id,requester_open_id,input_text,result_text,execution_status,created_at,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, 'message-' + id, topic, "fixture-owner", null, result, status, stamp, status === 'queued' ? null : stamp, ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(status) ? stamp : null);
      if (content !== null) db.prepare("INSERT INTO oncall_messages(message_id,chat_id,root_id,sender,content_json,received_at) VALUES(?,?,?,?,?,?)").run('message-' + id, row.chat_id, row.root_id, "fixture-owner", typeof content === 'string' ? content : JSON.stringify(content), stamp);
      db.prepare("INSERT INTO job_deliveries(job_id,kind,sequence,state,desired_version,created_at,updated_at,next_attempt_at) VALUES(?,'status',0,'delivered',1,?,?,?)").run(id, stamp, stamp, stamp);
      states.forEach((state, sequence) => db.prepare("INSERT INTO job_deliveries(job_id,kind,sequence,state,desired_version,created_at,updated_at,next_attempt_at,payload_text) VALUES(?,'final_reply',?,?,1,?,?,?,?)").run(id, sequence, state, stamp, stamp, stamp, "delivery-payload-not-for-browser"));
    };
    const addCase = (topic: string, id: number, summary: string, verification = "unverified", evidence = ["feishu-message:message-" + id], latest = true) => {
      const value = { summary, conclusions: [{ text: summary, verification }], evidence };
      const workspace = (db.prepare("SELECT workspace_id FROM oncall_topics WHERE topic_id=?").get(topic) as { workspace_id: string }).workspace_id;
      db.prepare("INSERT INTO oncall_case_history(job_id,topic_id,case_json,created_at) VALUES(?,?,?,?)").run(id, topic, JSON.stringify(value), now);
      if (latest) db.prepare("INSERT INTO oncall_cases(topic_id,workspace_id,summary,conclusions_json,evidence_json,last_job_id,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(topic_id) DO UPDATE SET summary=excluded.summary,conclusions_json=excluded.conclusions_json,evidence_json=excluded.evidence_json,last_job_id=excluded.last_job_id,updated_at=excluded.updated_at").run(topic, workspace, summary, JSON.stringify(value.conclusions), JSON.stringify(evidence), id, now);
    };
    db.transaction(() => {
      addTopic("topic-snapshot", "Sheet 落地页快照未就绪");
      addJob("topic-snapshot", 101, "succeeded", "旧轮次：已观察到快照检查失败。", ["delivered"]); addCase("topic-snapshot", 101, "旧轮次结论，仅确认检查失败。", "observed", ["旧轮次的证据"], false);
      addJob("topic-snapshot", 102, "succeeded", "本轮暂无可保存的案例。", ["delivered"]);
      addJob("topic-snapshot", 103, "succeeded", "异常发生在正式采样前。现有证据不足以判断具体根因。", ["delivered", "abandoned"], { text: "HTML_REPLAY_PEER_SNAPSHOT_NOT_READY，帮忙分析。" });
      addCase("topic-snapshot", 103, "快照未就绪，尚未确认具体根因。", "observed", ["assertReady 检查失败", "feishu-message:message-103", "环境准备时序仍缺少取证"]);
      const mixed = [{ text: "失败发生在正式采样前的快照就绪检查。", verification: "observed" }, { text: "可能与环境准备时序有关，具体根因尚无充分证据。", verification: "unverified" }];
      db.prepare("UPDATE oncall_cases SET conclusions_json=? WHERE topic_id='topic-snapshot'").run(JSON.stringify(mixed));
      db.prepare("UPDATE oncall_case_history SET case_json=? WHERE job_id=103").run(JSON.stringify({ summary: "快照未就绪，尚未确认具体根因。", conclusions: mixed, evidence: ["assertReady 检查失败", "feishu-message:message-103", "环境准备时序仍缺少取证"] }));
      addTopic("topic-stopping", "回放资源返回 403", "infra", true); addJob("topic-stopping", 200, "succeeded", "已观察到资源 403。", ["delivered"]); addCase("topic-stopping", 200, "资源 403，权限原因尚未确认。", "observed"); addJob("topic-stopping", 201, "cancel_requested", null); addJob("topic-stopping", 202, "queued", null);
      addTopic("topic-active", "Docx 首屏指标核对"); addJob("topic-active", 300, "succeeded", "已核对历史记录。", ["delivered"]); addCase("topic-active", 300, "历史记录中的配置差异。", "verified"); addJob("topic-active", 301, "running", null); addJob("topic-active", 302, "preparing", null);
      db.prepare("UPDATE jobs SET progress_json=? WHERE id=301").run(JSON.stringify({ active: [{ id: "progress-1", kind: "message", state: "running", title: "正在核对来源流水线配置与任务快照。" }], recent: [], completedCount: 0, failedCount: 0 }));
      addTopic("topic-queue", "CI 准备阶段未领取任务"); addJob("topic-queue", 401, "queued", null);
      addTopic("topic-failed", "任务日志接口不可用", "infra", true); addJob("topic-failed", 501, "failed", "日志接口不可用，无法继续取证。", ["delivered"]);
      addTopic("topic-damaged", "损坏记录降级显示"); addJob("topic-damaged", 601, "succeeded", "保留本轮结果。", ["delivered"], '{broken'); addCase("topic-damaged", 601, "损坏记录示例"); db.prepare("UPDATE jobs SET progress_json='{broken' WHERE id=601").run(); db.prepare("UPDATE oncall_case_history SET case_json='{broken' WHERE job_id=601").run(); db.prepare("UPDATE oncall_cases SET conclusions_json='{broken' WHERE topic_id='topic-damaged'").run();
      addTopic("topic-missing-root", "不会显示这个标题", "infra", false, false); addJob("topic-missing-root", 701, "succeeded", "结果仍可查看。", [], null);
      addTopic("topic-attachment", "附件输入"); addJob("topic-attachment", 801, "succeeded", "已接收附件。", ["delivered"], { text: "", assets: [{ name: "run.log", type: "file", key: "private-file-key" }], images: [{ path: "/data/private.png", media_type: "image/png" }], files: [{ name: "extra.log", path: "/data/extra.log" }] });
      addTopic("topic-literal", "字面 % _ 查询"); addJob("topic-literal", 901, "succeeded", "字面查询结果。", ["delivered"]); addCase("topic-literal", 901, "字面 % _ 与脚本显示测试", "verified", ["任务日志名称", "feishu-message:message-901", "/data/evidence/private.log", evidenceOrigin + "/?view=console", "javascript:alert(1)", '<img src=x onerror="window.unexpectedScript=true">']);
      addTopic("topic-multiple", "异常的多活动任务"); addJob("topic-multiple", 950, "running", null); addJob("topic-multiple", 951, "running", null);
      addTopic("topic-no-jobs", "尚无执行请求");
      for (const [offset, states] of [[0, ["delivered", "delivered"]], [1, ["delivered", "pending"]], [2, ["delivering", "pending"]], [3, []]] as const) { const id = 970 + offset; addTopic('topic-delivery-' + offset, '投递聚合 ' + offset); addJob('topic-delivery-' + offset, id, 'succeeded', '执行成功。', [...states]); }
      for (const workspace of ['infra', 'other']) for (let i = 0;i < 35;i++) { const topic = `${workspace}-bulk-${String(i).padStart(2, '0')}`, id = (workspace === 'infra' ? 1000 : 2000) + i; addTopic(topic, `任务记录 ${i}`, workspace); addJob(topic, id, 'succeeded', `完成记录 ${i}。`, ['delivered']); addCase(topic, id, `案例摘要 ${i}。`, i % 2 ? 'unverified' : 'verified'); }
      db.prepare("INSERT INTO topics(id,workspace_path,created_at,last_active_at) VALUES('legacy',?,?,?)").run(path.join(directory, 'legacy'), now, now);
    })();
    await fs.writeFile(path.join(directory, 'oncall.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
    await fs.writeFile(path.join(directory, 'browser.config.json'), JSON.stringify({ browser: { cdpEndpoint: null, remoteEndpoint: null, isolated: true, launchOptions: { chromiumSandbox: false } } }), { mode: 0o600 });
    async function health(sampledAt = new Date().toISOString()) {
      await fs.writeFile(path.join(directory, 'health.json'), JSON.stringify({ version: 1, sampledAt, service: { state: 'running', startedAt: now, lastIngressAt: null }, schemaVersion: 13, backend: 'codex', jobs: { preparing: 1, queued: 2, running: 3, cancelRequested: 1, oldestQueuedAt: now }, deliveries: { pending: 3, delivering: 1, abandoned: 1, lastSuccessfulAt: now }, databaseBytes: 0 }), { mode: 0o600 });
    }
    await health();
    return { directory, databasePath, db, config, health };
  } catch (error) { db.close(); throw error; }
}
