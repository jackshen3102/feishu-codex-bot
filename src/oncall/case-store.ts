import type Database from "better-sqlite3";
import { z } from "zod";

export const caseSchema = z.object({
  summary: z.string().max(4000),
  conclusions: z.array(z.object({
    text: z.string().max(4000),
    verification: z.enum(["observed", "verified", "unverified"]),
  })).max(30),
  evidence: z.array(z.string().max(4000)).max(40),
});
export type CaseSummary = z.infer<typeof caseSchema>;

export class CaseStore {
  constructor(private readonly db: Database.Database) {}

  save(topicId: string, jobId: number, summary: CaseSummary): void {
    const topic = this.db.prepare("SELECT workspace_id FROM oncall_topics WHERE topic_id = ?")
      .get(topicId) as { workspace_id: string } | undefined;
    if (!topic) return;
    const value = caseSchema.parse(summary);
    const timestamp = new Date().toISOString();
    const inserted = this.db.prepare(`INSERT INTO oncall_case_history(job_id, topic_id, case_json, created_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(job_id) DO NOTHING`).run(jobId, topicId, JSON.stringify(value), timestamp);
    if (inserted.changes === 0) return;
    // Resume jobs intentionally run before older queued jobs. Completion order,
    // rather than job creation order, determines the topic's current case.
    this.db.prepare(`INSERT INTO oncall_cases(topic_id, workspace_id, summary, conclusions_json, evidence_json, last_job_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(topic_id) DO UPDATE SET
      summary=excluded.summary, conclusions_json=excluded.conclusions_json, evidence_json=excluded.evidence_json,
      last_job_id=excluded.last_job_id, updated_at=excluded.updated_at`)
      .run(topicId, topic.workspace_id, value.summary, JSON.stringify(value.conclusions), JSON.stringify(value.evidence), jobId, timestamp);
  }

  search(workspaceId: string, query: string, excludeTopic?: string): unknown[] {
    const terms = [...new Set(query.match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])].slice(0, 12);
    if (terms.length === 0) return [];
    const rows = this.db.prepare(`SELECT * FROM oncall_cases WHERE workspace_id = ? AND topic_id != ?
      AND (${terms.map(() => "instr(lower(summary || ' ' || conclusions_json), lower(?)) > 0").join(" OR ")})
      ORDER BY updated_at DESC LIMIT 8`).all(workspaceId, excludeTopic ?? "", ...terms) as Array<{
        topic_id: string; summary: string; conclusions_json: string; evidence_json: string; updated_at: string;
      }>;
    return rows.map((row) => ({ topicId: row.topic_id, summary: row.summary,
      conclusions: JSON.parse(row.conclusions_json), evidence: JSON.parse(row.evidence_json), updatedAt: row.updated_at }));
  }
}
