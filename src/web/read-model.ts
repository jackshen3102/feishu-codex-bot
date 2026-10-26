import Database from "better-sqlite3";
import fs from "node:fs";
import type { OncallConfig } from "../oncall/workspace-config.js";
import type { AgentProgressSnapshot, DeliveryState, ExecutionStatus } from "../contracts.js";
import { WebError, type JobSummary, type JobDetail, type TopicSummary, type WebCase, type ListQuery, type Page } from "./contracts.js";

type Row = Record<string, any>;
const text = (v: unknown): string => typeof v === "string" ? v : "";
function object(v: unknown): v is Row { return v !== null && typeof v === "object" && !Array.isArray(v); }
function parse(value: unknown, warning: string, warnings: string[]): unknown {
  try { return JSON.parse(text(value)); } catch { warnings.push(warning); return null; }
}
function safeUrl(value: string): string {
  try { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol)) return ""; url.username = ""; url.password = ""; return url.href; } catch { return ""; }
}
function job(row: Row): JobSummary {
  const total = Number(row.reply_total || 0), delivered = Number(row.reply_delivered || 0), abandoned = Number(row.reply_abandoned || 0);
  const state: DeliveryState | null = total === 0 ? null : abandoned > 0 ? "abandoned" : delivered === total ? "delivered" : row.reply_delivering > 0 ? "delivering" : "pending";
  return {
    id: row.id, executionStatus: row.execution_status as ExecutionStatus,
    createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at, errorKind: row.error_kind,
    finalReply: { state, totalCount: total, deliveredCount: delivered, abandonedCount: abandoned }
  };
}
function caseData(value: unknown, meta: { topicId: string; jobId: number; updatedAt: string }, warnings: string[]): WebCase {
  if (!object(value)) { warnings.push("案例记录损坏"); value = {}; }
  const item = value as Row;
  const conclusions = Array.isArray(item.conclusions) ? item.conclusions.filter(object).filter(c => typeof c.text === "string").map(c => ({ text: c.text as string, ...(typeof c.verification === "string" ? { verification: c.verification } : {}) })) : [];
  const evidence = Array.isArray(item.evidence) ? item.evidence.filter((e: unknown): e is string => typeof e === "string") : [];
  if (typeof item.summary !== "string" || !Array.isArray(item.conclusions) || !Array.isArray(item.evidence)) warnings.push("案例字段不完整");
  return { topicId: meta.topicId, sourceJobId: meta.jobId, summary: text(item.summary), conclusions, evidence, updatedAt: meta.updatedAt, dataWarnings: warnings };
}
function progressData(raw: unknown, warnings: string[]): AgentProgressSnapshot | null {
  if (!raw) return null;
  const data = parse(raw, "进展记录损坏", warnings);
  const validItem = (v: unknown) => object(v) && typeof v.id === "string" && v.kind === "message" && ["running", "completed", "failed"].includes(v.state) && typeof v.title === "string" && (v.detail === undefined || typeof v.detail === "string");
  if (!object(data) || !Array.isArray(data.active) || !Array.isArray(data.recent) || !data.active.every(validItem) || !data.recent.every(validItem) || !Number.isInteger(data.completedCount) || !Number.isInteger(data.failedCount)) {
    if (!warnings.includes("进展记录损坏")) warnings.push("进展字段不完整"); return null;
  }
  // Project only the user-facing progress fields, never return unknown JSON keys.
  const items = (list: Row[]) => list.map(v => ({ id: v.id, kind: "message" as const, state: v.state, title: v.title, ...(v.detail ? { detail: v.detail } : {}) }));
  return { active: items(data.active), recent: items(data.recent), completedCount: data.completedCount, failedCount: data.failedCount };
}

const deliveryCte = `
WITH deliveries AS (
 SELECT d.job_id, COUNT(*) reply_total, SUM(d.state='delivered') reply_delivered,
 SUM(d.state='abandoned') reply_abandoned, SUM(d.state='delivering') reply_delivering
 FROM job_deliveries d JOIN jobs j ON j.id=d.job_id JOIN oncall_topics o ON o.topic_id=j.topic_id
 WHERE o.workspace_id=@workspaceId AND d.kind='final_reply' GROUP BY d.job_id
), scoped_jobs AS (
 SELECT j.id,j.topic_id,j.execution_status,j.created_at,j.started_at,j.finished_at,j.error_kind,
 COALESCE(d.reply_total,0) reply_total,COALESCE(d.reply_delivered,0) reply_delivered,
 COALESCE(d.reply_abandoned,0) reply_abandoned,COALESCE(d.reply_delivering,0) reply_delivering
 FROM jobs j JOIN oncall_topics o ON o.topic_id=j.topic_id LEFT JOIN deliveries d ON d.job_id=j.id
 WHERE o.workspace_id=@workspaceId
)`;
const topicCte = `${deliveryCte}, ranked_jobs AS (
 SELECT *, ROW_NUMBER() OVER(PARTITION BY topic_id ORDER BY CASE
 WHEN execution_status IN ('running','cancel_requested') THEN 0 WHEN execution_status='preparing' THEN 1 ELSE 2 END,id DESC) rank,
 SUM(execution_status IN ('running','cancel_requested')) OVER(PARTITION BY topic_id) active_count,
 SUM(execution_status='queued') OVER(PARTITION BY topic_id) queued_count,
 SUM(reply_abandoned>0) OVER(PARTITION BY topic_id) failed_reply_jobs
 FROM scoped_jobs
), topic_rows AS (
 SELECT o.topic_id,o.workspace_id,o.chat_id,o.owner_open_id,o.paused,o.pause_reason,t.last_active_at,
 CASE WHEN json_valid(m.content_json) THEN COALESCE(json_extract(m.content_json,'$.text'),'') ELSE '' END root_text,
 r.id,r.execution_status,r.created_at,r.started_at,r.finished_at,r.error_kind,r.reply_total,r.reply_delivered,r.reply_abandoned,r.reply_delivering,r.active_count,r.queued_count,r.failed_reply_jobs, (o.paused=1 OR r.execution_status IN ('failed','interrupted','cancel_requested') OR r.active_count>1 OR r.failed_reply_jobs>0) attention
 FROM oncall_topics o JOIN topics t ON t.id=o.topic_id
 LEFT JOIN ranked_jobs r ON r.topic_id=o.topic_id AND r.rank=1
 LEFT JOIN oncall_messages m ON m.message_id=o.root_id AND m.chat_id=o.chat_id AND m.root_id=o.root_id
 WHERE o.workspace_id=@workspaceId
)`;

// This connection owns no migrations, scheduler or filesystem maintenance.
export class WebReadModel {
  private readonly db: Database.Database;
  constructor(databasePath: string, readonly config: OncallConfig) {
    if (!fs.lstatSync(databasePath).isFile()) throw new Error("Web database is not a regular file");
    this.db = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 250 });
    try {
      this.db.pragma("query_only = ON");
      // Probe the exact read contract. Incompatible databases are not migrated here.
      this.db.prepare(`${topicCte} SELECT * FROM topic_rows LIMIT 0`).all({ workspaceId: "" });
      this.db.prepare("SELECT job_id, topic_id, case_json, created_at FROM oncall_case_history LIMIT 0").all();
      this.db.prepare("SELECT topic_id,workspace_id,summary,conclusions_json,evidence_json,last_job_id,updated_at FROM oncall_cases LIMIT 0").all();
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  snapshot<T>(read: () => T): T { return this.db.transaction(read)(); }
  workspace(id: string) {
    const result = this.config.workspaces.find(w => w.id === id);
    if (!result) throw new WebError(404, "not_found", "工作区不存在");
    return result;
  }
  workspaces() {
    return this.config.workspaces.map(w => ({
      id: w.id, knowledgePaths: w.knowledgePaths,
      repositories: w.repositories.map(r => ({ name: r.name, url: safeUrl(r.url), description: r.description, defaultRef: r.defaultRef })),
      bindings: [...this.config.groupBindings.filter(b => b.workspaceId === w.id).map(b => ({ chatId: b.chatId, type: "group" })),
      ...(this.config.privateBinding.workspaceId === w.id ? [{ chatId: this.config.privateBinding.chatId, type: "private" }] : [])]
    }));
  }
  private topicRow(row: Row): TopicSummary {
    const currentJob = row.id == null ? null : job(row);
    const root = text(row.root_text).split(/\r?\n/).find(v => v.trim())?.trim();
    return {
      id: row.topic_id, title: root?.slice(0, 80) || `话题 ${String(row.topic_id).slice(0, 8)}`,
      workspaceId: row.workspace_id, chatType: row.chat_id === this.config.privateBinding.chatId ? "private" : "group", chatId: row.chat_id, ownerId: row.owner_open_id,
      paused: row.paused === 1, pauseReason: row.pause_reason, queuedCount: Number(row.queued_count || 0),
      currentJob, multipleActiveJobs: row.active_count > 1, needsAttention: row.attention === 1, updatedAt: row.last_active_at
    };
  }
  overview(workspaceId: string, maxConcurrentTurns: number) {
    this.workspace(workspaceId);
    return this.snapshot(() => {
      const topics = this.db.prepare(`${topicCte} SELECT COUNT(*) topics,COALESCE(SUM(attention=1),0) attention FROM topic_rows`).get({ workspaceId }) as Row;
      const jobs = this.db.prepare(`${deliveryCte} SELECT COALESCE(SUM(execution_status IN ('running','cancel_requested')),0) occupied,COALESCE(SUM(execution_status='queued'),0) queued,COALESCE(SUM(reply_abandoned>0),0) failures FROM scoped_jobs`).get({ workspaceId }) as Row;
      return { topicCount: topics.topics, attentionTopics: topics.attention, occupiedJobs: jobs.occupied, maxConcurrentTurns, queuedJobs: jobs.queued, failedReplyJobs: jobs.failures };
    });
  }
  topic(workspaceId: string, topicId: string): TopicSummary {
    this.workspace(workspaceId);
    const row = this.db.prepare(`${topicCte} SELECT * FROM topic_rows WHERE topic_id=@topicId`).get({ workspaceId, topicId }) as Row | undefined;
    if (!row) throw new WebError(404, "not_found", "话题不存在");
    return this.topicRow(row);
  }
  private cursor(query: ListQuery, kind: string): { time: string; id: string | number } | null {
    if (!query.cursor) return null;
    try {
      if (query.cursor.length > 2048) throw new Error();
      const data = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      if (!object(data) || data.scope !== JSON.stringify([kind, query.workspaceId, query.q, query.filter]) || typeof data.time !== "string" || !(typeof data.id === "string" || Number.isSafeInteger(data.id))) throw new Error();
      const isJob = kind.startsWith("jobs:");
      if (isJob ? !Number.isSafeInteger(data.id) || data.id < 1 : typeof data.id !== "string" || !data.id || !data.time || data.id.length > 512) throw new Error();
      return { time: data.time, id: data.id };
    } catch { throw new WebError(400, "invalid_cursor", "分页游标无效，请重新查询"); }
  }
  private next(query: ListQuery, kind: string, time: string, id: string | number): string {
    return Buffer.from(JSON.stringify({ scope: JSON.stringify([kind, query.workspaceId, query.q, query.filter]), time, id })).toString("base64url");
  }
  topics(query: ListQuery): Page<TopicSummary> {
    this.workspace(query.workspaceId);
    const cursor = this.cursor(query, "topics");
    const rows = this.db.prepare(`${topicCte} SELECT * FROM topic_rows WHERE
      (@q='' OR instr(lower(topic_id),lower(@q))>0 OR instr(lower(root_text),lower(@q))>0)
      AND (@filter='all' OR (@filter='attention' AND attention=1) OR execution_status=@filter)
      AND (@after=0 OR last_active_at<@time OR (last_active_at=@time AND topic_id<@id))
      ORDER BY last_active_at DESC,topic_id DESC LIMIT @limit`).all({ workspaceId: query.workspaceId, q: query.q, filter: query.filter, after: cursor ? 1 : 0, time: cursor?.time || "", id: cursor?.id || "", limit: query.limit + 1 }) as Row[];
    const items = rows.slice(0, query.limit); const last = items.at(-1);
    return { items: items.map(r => this.topicRow(r)), nextCursor: rows.length > query.limit && last ? this.next(query, "topics", last.last_active_at, last.topic_id) : null };
  }
  jobs(query: ListQuery, topicId: string): Page<JobSummary> {
    return this.snapshot(() => {
      this.topic(query.workspaceId, topicId);
      const cursor = this.cursor(query, "jobs:" + topicId);
      if (cursor && (!Number.isSafeInteger(cursor.id) || Number(cursor.id) < 1)) throw new WebError(400, "invalid_cursor", "分页游标无效");
      const rows = this.db.prepare(`${deliveryCte} SELECT * FROM scoped_jobs WHERE topic_id=@topicId AND (@id=0 OR id<@id) ORDER BY id DESC LIMIT @limit`).all({ workspaceId: query.workspaceId, topicId, id: cursor?.id || 0, limit: query.limit + 1 }) as Row[];
      const items = rows.slice(0, query.limit), last = items.at(-1);
      return { items: items.map(job), nextCursor: rows.length > query.limit && last ? this.next(query, "jobs:" + topicId, "", last.id) : null };
    });
  }
  jobDetail(workspaceId: string, topicId: string, jobId: number): JobDetail {
    return this.snapshot(() => {
      this.topic(workspaceId, topicId);
      const row = this.db.prepare(`${deliveryCte} SELECT s.*,j.result_text,j.progress_json,m.content_json
        FROM scoped_jobs s JOIN jobs j ON j.id=s.id JOIN oncall_topics o ON o.topic_id=j.topic_id
        LEFT JOIN oncall_messages m ON m.message_id=j.feishu_message_id AND m.chat_id=o.chat_id AND m.root_id=o.root_id
        WHERE s.topic_id=@topicId AND s.id=@jobId`).get({ workspaceId, topicId, jobId }) as Row | undefined;
      if (!row) throw new WebError(404, "not_found", "执行轮次不存在");
      const warnings: string[] = [];
      let input: JobDetail["input"] = null;
      if (row.content_json) {
        const content = parse(row.content_json, "请求记录损坏", warnings);
        if (object(content)) {
          const attachments: Array<{ name: string; type: string }> = [];
          for (const list of [content.assets, content.images, content.files]) {
            if (Array.isArray(list)) for (const asset of list.filter(object)) attachments.push({ name: text(asset.name) || (asset.media_type || asset.type === "image" ? "图片" : "附件"), type: text(asset.type) || (asset.media_type ? "image" : "file") });
          }
          input = { text: text(content.text), attachments };
        } else if (!warnings.includes("请求记录损坏")) warnings.push("请求字段不完整");
      }
      const history = this.db.prepare("SELECT case_json,created_at FROM oncall_case_history WHERE job_id=? AND topic_id=?").get(jobId, topicId) as Row | undefined;
      const caseWarnings: string[] = [];
      const caseSummary = history ? caseData(parse(history.case_json, "案例记录损坏", caseWarnings), { topicId, jobId, updatedAt: history.created_at }, caseWarnings) : null;
      const progress = progressData(row.progress_json, warnings);
      return { job: job(row), input, resultText: row.result_text, progress, caseSummary, dataWarnings: [...new Set([...warnings, ...caseWarnings])] };
    });
  }
  private currentCase(row: Row): WebCase {
    const warnings: string[] = [];
    return caseData({ summary: row.summary, conclusions: parse(row.conclusions_json, "结论记录损坏", warnings), evidence: parse(row.evidence_json, "证据记录损坏", warnings) }, { topicId: row.topic_id, jobId: row.last_job_id, updatedAt: row.updated_at }, warnings);
  }
  cases(query: ListQuery): Page<WebCase> {
    this.workspace(query.workspaceId); const cursor = this.cursor(query, "cases");
    const rows = this.db.prepare(`SELECT c.* FROM oncall_cases c JOIN oncall_topics o ON o.topic_id=c.topic_id
      WHERE c.workspace_id=@workspaceId AND o.workspace_id=@workspaceId
      AND (@q='' OR instr(lower(c.summary),lower(@q))>0 OR instr(lower(c.conclusions_json),lower(@q))>0)
      AND (@filter='all' OR EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(c.conclusions_json) THEN c.conclusions_json ELSE '[]' END) item WHERE json_extract(CASE WHEN json_valid(item.value) THEN item.value ELSE '{}' END,'$.verification')='verified'))
      AND (@after=0 OR c.updated_at<@time OR (c.updated_at=@time AND c.topic_id<@id))
      ORDER BY c.updated_at DESC,c.topic_id DESC LIMIT @limit`).all({ workspaceId: query.workspaceId, q: query.q, filter: query.filter, after: cursor ? 1 : 0, time: cursor?.time || "", id: cursor?.id || "", limit: query.limit + 1 }) as Row[];
    const items = rows.slice(0, query.limit), last = items.at(-1);
    return { items: items.map(r => this.currentCase(r)), nextCursor: rows.length > query.limit && last ? this.next(query, "cases", last.updated_at, last.topic_id) : null };
  }
  case(workspaceId: string, topicId: string): WebCase {
    this.workspace(workspaceId);
    const row = this.db.prepare(`SELECT c.* FROM oncall_cases c JOIN oncall_topics o ON o.topic_id=c.topic_id WHERE c.topic_id=? AND c.workspace_id=? AND o.workspace_id=?`).get(topicId, workspaceId, workspaceId) as Row | undefined;
    if (!row) throw new WebError(404, "not_found", "案例不存在"); return this.currentCase(row);
  }
}
