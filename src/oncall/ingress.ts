import path from "node:path";
import type { TurnRunner } from "../agent/runner.js";
import { containsProtectedCredential, type AppConfig } from "../config.js";
import type { FeishuMessageEvent } from "../contracts.js";
import type { Store } from "../db/store.js";
import type { IngressResult, IngressSignals } from "../feishu/ingress.js";
import type { FeishuDelivery } from "../feishu/messages.js";
import { stableIngressReplyUuid } from "../jobs/delivery-ids.js";
import type { WorkspaceManager } from "../workspaces.js";
import { CaseStore } from "./case-store.js";
import { OncallStore, type TopicInput } from "./store.js";
import { resolveWorkspace, type OncallConfig } from "./workspace-config.js";

function parseInput(event: FeishuMessageEvent, botOpenId: string): TopicInput {
  const { message } = event;
  const body = JSON.parse(message.content) as Record<string, unknown>;
  const input: TopicInput = { text: "", assets: [] };
  if (message.message_type === "text") input.text = typeof body.text === "string" ? body.text : "";
  else if (message.message_type === "image" && typeof body.image_key === "string") {
    input.assets!.push({ type: "image", key: body.image_key });
  } else if (message.message_type === "file" && typeof body.file_key === "string") {
    input.assets!.push({ type: "file", key: body.file_key, name: typeof body.file_name === "string" ? body.file_name : "attachment.log" });
  } else if (message.message_type === "post" || message.message_type === "interactive") {
    const texts: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { for (const item of value) walk(item); return; }
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (typeof record.text === "string") texts.push(record.text);
      if (typeof record.title === "string") texts.push(record.title);
      if (typeof record.href === "string") texts.push(record.href);
      if (typeof record.content === "string") texts.push(record.content);
      if (record.tag === "img" && typeof record.image_key === "string") input.assets!.push({ type: "image", key: record.image_key });
      for (const nested of Object.values(record)) if (nested && typeof nested === "object") walk(nested);
    };
    walk(body);
    input.text = texts.join("\n");
  } else throw new Error("unsupported input");
  for (const mention of message.mentions ?? []) {
    if (mention.id.open_id === botOpenId) input.text = input.text.split(mention.key).join("");
  }
  input.text = input.text.trim();
  if (!input.text && !input.assets?.length && !message.mentions?.some((m) => m.id.open_id === botOpenId)) throw new Error("empty input");
  if (Buffer.byteLength(input.text) > 262_144) throw new Error("input too large");
  return input;
}

/** Transport routing only. Business investigation and action selection remain with the Agent. */
export class OncallIngress {
  private readonly topics: OncallStore;
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(
    private readonly config: AppConfig,
    private readonly oncall: OncallConfig,
    private readonly botOpenId: string,
    private readonly store: Store,
    private readonly delivery: FeishuDelivery,
    private readonly signals: IngressSignals,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: TurnRunner,
  ) { this.topics = new OncallStore(store); }

  handle(event: FeishuMessageEvent): Promise<IngressResult> {
    const root = event.message.root_id ?? event.message.parent_id ?? event.message.message_id;
    // Serialize each topic while allowing unrelated topics to prepare input independently.
    const bound = this.topics.find(event.message.chat_id, root, event.message.parent_id);
    const key = `${event.message.chat_id}:${bound?.root_id ?? root}`;
    // A slow attachment download must not postpone an explicit stop.
    if (bound) {
      try {
        if (["停止", "取消"].includes(parseInput(event, this.botOpenId).text)) return this.accept(event, root);
      } catch { /* Normal input validation below reports the error. */ }
    }
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.accept(event, root));
    this.tails.set(key, current);
    void current.finally(() => { if (this.tails.get(key) === current) this.tails.delete(key); }).catch(() => undefined);
    return current;
  }

  private async accept(event: FeishuMessageEvent, candidateRoot: string): Promise<IngressResult> {
    let workspace = resolveWorkspace(this.oncall, event);
    const sender = event.sender.sender_id?.open_id;
    if (!workspace || !sender) return "ignored";
    const { message } = event;
    if (this.topics.hasMessage(message.message_id)) return "duplicate";
    let topic = this.topics.find(message.chat_id, candidateRoot, message.parent_id);
    const root = topic?.root_id ?? candidateRoot;
    const mentioned = message.mentions?.some((m) => m.id.open_id === this.botOpenId) === true;
    let input: TopicInput;
    try { input = parseInput(event, this.botOpenId); }
    catch {
      if (!topic && !mentioned) return "ignored";
      await this.reply(message.message_id, "无法读取这条消息，请提供文字、截图、日志附件或链接。", "input-invalid");
      return "rejected";
    }
    if (containsProtectedCredential(this.config, JSON.stringify(input))) {
      await this.reply(message.message_id, "消息包含受保护内容，已拒绝处理。", "protected-input");
      return "rejected";
    }
    const command = input.text;
    if (topic && ["停止", "取消"].includes(command)) {
      const active = this.store.getAllJobs().find((j) => j.topicId === topic!.topic_id && ["running", "cancel_requested"].includes(j.executionStatus));
      if (sender !== (active?.requesterOpenId ?? topic.owner_open_id)) {
        await this.reply(message.message_id, "请由当前任务的发起人停止此话题。", "stop-owner");
        return "rejected";
      }
      this.store.database.transaction(() => {
        this.topics.record(message.message_id, message.chat_id, root, sender, input, message.create_time);
        this.topics.pause(topic!.topic_id, "user_stopped");
        if (active) this.store.requestCancellation(active.id, sender);
        this.refreshQueued(topic!.topic_id);
      })();
      if (active) this.runner.abort(active.id);
      this.signals.deliveryReady();
      await this.reply(message.message_id, "本话题已暂停，正在停止当前执行。排队请求和上下文已保留；明确回复“继续”后恢复。", "topic-stopped");
      return "accepted";
    }
    if (topic && command === "继续" && topic.resume_job_id) {
      const existing = this.store.getJob(topic.resume_job_id);
      if (existing && ["preparing", "queued", "running", "cancel_requested"].includes(existing.executionStatus)) {
        this.topics.record(message.message_id, message.chat_id, root, sender, input, message.create_time);
        await this.reply(message.message_id, "恢复请求已排队或正在执行，请等待本轮结果。", "resume-pending");
        return "accepted";
      }
    }
    const resuming = Boolean(topic?.paused && command === "继续");
    if (resuming && this.store.getAllJobs().some((j) => j.topicId === topic!.topic_id && ["running", "cancel_requested"].includes(j.executionStatus))) {
      await this.reply(message.message_id, "当前执行仍在停止中，请结束后再回复“继续”。", "still-stopping");
      return "rejected";
    }
    // Switching is explicit and topic-scoped. Existing contexts never silently cross workspaces.
    if (command.startsWith("切换工作区 ")) {
      const target = this.oncall.workspaces.find((w) => w.id === command.slice("切换工作区 ".length).trim());
      if (message.chat_type !== "p2p" || topic) {
        await this.reply(message.message_id, "请在私聊的新话题中指定“切换工作区 名称”，已有话题继续使用原工作区。", "workspace-bound");
        return "rejected";
      }
      if (!target) {
        await this.reply(message.message_id, `可用工作区：${this.oncall.workspaces.map((w) => w.id).join("、")}`, "workspace-unknown");
        return "rejected";
      }
      workspace = target;
    }
    if (!mentioned && !resuming && !command.startsWith("切换工作区 ")) {
      this.topics.record(message.message_id, message.chat_id, root, sender, input, message.create_time);
      if (topic) this.topics.touch(topic.topic_id);
      return "accepted";
    }

    const gaps: string[] = [];
    if (!topic && root !== message.message_id) {
      if (this.delivery.fetchTopicHistory) {
        try {
          const history = await this.delivery.fetchTopicHistory(message.chat_id, root, message.thread_id);
          for (const item of history.events) {
            if (item.message.message_id === message.message_id || item.sender.sender_id?.open_id === this.botOpenId) continue;
            if (message.create_time && item.message.create_time && Number(item.message.create_time) > Number(message.create_time)) continue;
            try {
              const content = parseInput(item, this.botOpenId);
              if (!containsProtectedCredential(this.config, JSON.stringify(content))) this.topics.record(
                item.message.message_id, message.chat_id, root, `history:${item.sender.sender_id?.open_id ?? "unknown"}`,
                content, item.message.create_time,
              );
            } catch { gaps.push(`无法读取历史消息 ${item.message.message_id}`); }
          }
          if (history.truncated) gaps.push("自动预读只包含最近 50 条历史和根消息；需要时继续查阅更早记录。");
        } catch { gaps.push("无法读取话题历史，当前输入可能不完整。"); }
      } else gaps.push("话题历史读取工具不可用。");
    }

    const accepted = this.store.database.transaction(() => {
      const boundary = this.topics.record(message.message_id, message.chat_id, root, sender, input, message.create_time);
      const result = this.store.acceptJob({
        messageId: message.message_id, chatId: message.chat_id, requesterOpenId: sender,
        rootId: root === message.message_id ? undefined : root, parentId: message.parent_id,
        allowNewTopic: true, executionMode: "unrestricted", existingTopicInput: null, newTopicInput: null,
      });
      if (result.topic) {
        this.store.database.prepare(`INSERT INTO oncall_topics(topic_id, workspace_id, chat_id, root_id, owner_open_id)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(topic_id) DO NOTHING`)
          .run(result.topic.id, workspace.id, message.chat_id, root, sender);
        if (resuming && result.job) this.store.database.prepare("UPDATE oncall_topics SET resume_job_id = ? WHERE topic_id = ?")
          .run(result.job.id, result.topic.id);
      }
      return { ...result, boundary };
    })();
    if (!accepted.accepted || !accepted.job || !accepted.topic) return "duplicate";
    const job = accepted.job;
    const actualTopic = accepted.topic;
    topic = this.topics.topic(actualTopic.id)!;
    const boundWorkspace = this.oncall.workspaces.find((w) => w.id === topic!.workspace_id);
    if (!boundWorkspace) {
      this.store.failInputPreparation(job.id, "话题关联的工作区已不可用，请管理员恢复配置。", "workspace_missing");
      this.signals.deliveryReady();
      return "rejected";
    }
    this.signals.deliveryReady();
    try {
      const context = this.topics.context(message.chat_id, root, accepted.boundary) as Array<TopicInput & { messageId: string }>;
      for (const item of context) await this.prepareAssets(actualTopic.workspacePath, item);
      const contextFile = await this.workspaces.writeInputFile(actualTopic.workspacePath,
        `${message.message_id}:context`, Buffer.from(JSON.stringify(context, null, 2)), "json");
      if (context.length > 100) gaps.push("预览只展示最近 100 条消息；完整已接收记录（含原始问题）保存在 contextFile，请按需读取。");
      const preview = context.slice(-100).map((item) => ({ ...item, text: item.text.length > 2000
        ? `${item.text.slice(0, 2000)}\n[正文已截取，完整内容见 contextFile]` : item.text }));
      const previous = resuming ? this.store.getAllJobs().filter((j) => j.topicId === actualTopic.id && j.id !== job.id && ["interrupted", "cancelled", "failed"].includes(j.executionStatus)).at(-1) : undefined;
      const prompt = JSON.stringify({
        source: "feishu", chat_id: message.chat_id, message_id: message.message_id, sender_open_id: sender,
        text: input.text || "请结合本话题提供的材料分析问题。",
        oncall: {
          workspace: boundWorkspace, context: preview, contextFile, historyGaps: gaps,
          relatedCases: new CaseStore(this.store.database).search(boundWorkspace.id, context.map((c) => c.text).join("\n"), actualTopic.id),
          ...(resuming ? { recovery: {
            reason: topic.pause_reason, interruptedJob: previous ? { id: previous.id, status: previous.executionStatus } : null,
            instruction: "用户要求继续。先检查会话与实际外部状态，确认中断轮次已做什么；禁止重放已经完成或结果不明的外部动作。完成核对和本轮续接后，后续排队请求将依次处理。",
          } } : {}),
        },
      });
      this.store.database.transaction(() => {
        this.store.markInputReady(job.id, prompt);
        if (resuming) this.store.database.prepare("UPDATE oncall_topics SET paused = 0, pause_reason = NULL WHERE topic_id = ? AND resume_job_id = ?")
          .run(actualTopic.id, job.id);
        this.refreshQueued(actualTopic.id);
      })();
      this.signals.executionReady();
      this.signals.deliveryReady();
      return "accepted";
    } catch {
      if (this.store.getJob(job.id)?.executionStatus === "preparing") this.store.failInputPreparation(job.id, "输入准备失败，现场已保留，请在原话题重新 @ 并补充请求。", "oncall_input_failed");
      this.signals.deliveryReady();
      return "rejected";
    }
  }

  private async prepareAssets(workspacePath: string, input: TopicInput & { messageId: string }): Promise<void> {
    const pending: NonNullable<TopicInput["assets"]> = [];
    for (const asset of input.assets ?? []) {
      try {
        if (asset.type === "image") {
          const image = await this.delivery.fetchImage(input.messageId, asset.key, 5 * 1024 * 1024);
          const file = await this.workspaces.writeInputFile(workspacePath, `${input.messageId}:${asset.type}:${asset.key}`, image.data, image.extension);
          (input.images ??= []).push({ path: file, media_type: image.mediaType, source_message_id: input.messageId });
        } else {
          if (!this.delivery.fetchFile) throw new Error("file reader unavailable");
          const data = await this.delivery.fetchFile(input.messageId, asset.key, this.oncall.maxAttachmentBytes);
          if (containsProtectedCredential(this.config, data.toString("utf8"))) throw new Error("protected file");
          const file = await this.workspaces.writeInputFile(workspacePath, `${input.messageId}:${asset.type}:${asset.key}`, data, path.extname(asset.name ?? "").slice(1));
          (input.files ??= []).push({ path: file, name: asset.name ?? "attachment", source_message_id: input.messageId });
        }
      } catch {
        pending.push(asset);
        (input.gaps ??= []).push(`附件 ${asset.name ?? asset.type} 下载失败或超过限制，请勿假设已读取其内容。`);
      }
    }
    // Cache successful preparation; a subsequent turn can retry missing assets.
    const { messageId, ...stored } = input;
    this.store.database.prepare("UPDATE oncall_messages SET content_json = ? WHERE message_id = ?")
      .run(JSON.stringify({ ...stored, assets: pending }), messageId);
    delete input.assets;
  }

  private refreshQueued(topicId: string): void {
    this.store.database.prepare("UPDATE jobs SET status_version = status_version + 1 WHERE topic_id = ? AND execution_status = 'queued'").run(topicId);
    this.store.database.prepare(`UPDATE job_deliveries SET
      state = CASE WHEN state = 'delivering' THEN 'delivering' ELSE 'pending' END,
      next_attempt_at = CASE WHEN state = 'delivering' THEN next_attempt_at ELSE ? END,
      desired_version = (SELECT status_version FROM jobs WHERE jobs.id = job_deliveries.job_id)
      WHERE kind = 'status' AND job_id IN (SELECT id FROM jobs WHERE topic_id = ? AND execution_status = 'queued')`)
      .run(new Date().toISOString(), topicId);
  }

  private reply(messageId: string, text: string, kind: string): Promise<unknown> {
    return this.delivery.reply(messageId, text, stableIngressReplyUuid(messageId, kind));
  }
}
