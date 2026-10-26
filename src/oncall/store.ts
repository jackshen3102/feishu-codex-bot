import type { Store } from "../db/store.js";

export interface OncallTopic {
  topic_id: string; workspace_id: string; chat_id: string; root_id: string;
  owner_open_id: string; paused: number; pause_reason: string | null; resume_job_id: number | null;
}
export interface TopicInput {
  text: string;
  assets?: Array<{ type: "image" | "file"; key: string; name?: string }>;
  images?: Array<{ path: string; media_type: string; source_message_id: string }>;
  files?: Array<{ path: string; name: string; source_message_id: string }>;
  gaps?: string[];
}

export class OncallStore {
  constructor(readonly store: Store) {}

  topic(id: string): OncallTopic | undefined {
    return this.store.database.prepare("SELECT * FROM oncall_topics WHERE topic_id = ?").get(id) as OncallTopic | undefined;
  }

  find(chatId: string, rootId: string, parentId?: string): OncallTopic | undefined {
    const bound = this.store.findBoundTopic(chatId, parentId, rootId);
    if (bound) return this.topic(bound.id);
    return this.store.database.prepare("SELECT * FROM oncall_topics WHERE chat_id = ? AND root_id = ?")
      .get(chatId, rootId) as OncallTopic | undefined;
  }

  hasMessage(messageId: string): boolean {
    return Boolean(this.store.database.prepare("SELECT 1 FROM oncall_messages WHERE message_id = ?").get(messageId));
  }

  record(messageId: string, chatId: string, rootId: string, sender: string, content: TopicInput, sourceTime?: string): number {
    this.store.database.prepare(`INSERT INTO oncall_messages(message_id, chat_id, root_id, sender, content_json, source_time, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING`)
      .run(messageId, chatId, rootId, sender, JSON.stringify(content), sourceTime ?? null, new Date().toISOString());
    return (this.store.database.prepare("SELECT sequence FROM oncall_messages WHERE message_id = ?")
      .get(messageId) as { sequence: number }).sequence;
  }

  context(chatId: string, rootId: string, boundary: number): unknown[] {
    const rows = this.store.database.prepare(`SELECT * FROM (
      SELECT message_id, sender, content_json, source_time, sequence FROM oncall_messages
      WHERE chat_id = ? AND root_id = ? AND sequence <= ? ORDER BY sequence DESC
    ) ORDER BY sequence`).all(chatId, rootId, boundary) as Array<{
      message_id: string; sender: string; content_json: string; source_time: string | null;
    }>;
    return rows.map((row) => ({ messageId: row.message_id, sender: row.sender,
      sourceTime: row.source_time, ...JSON.parse(row.content_json) }));
  }

  touch(topicId: string): void {
    this.store.database.prepare("UPDATE topics SET last_active_at = ? WHERE id = ?")
      .run(new Date().toISOString(), topicId);
  }

  pause(topicId: string, reason: string): void {
    this.store.database.prepare("UPDATE oncall_topics SET paused = 1, pause_reason = ?, resume_job_id = NULL WHERE topic_id = ?")
      .run(reason, topicId);
    this.touch(topicId);
  }
}
