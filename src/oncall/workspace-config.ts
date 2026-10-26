import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FeishuMessageEvent } from "../contracts.js";

const absolutePath = z.string().refine(path.isAbsolute, "must be an absolute container path");
const workspaceSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  knowledgePaths: z.array(absolutePath).default([]),
  repositories: z.array(z.object({
    name: z.string().min(1), url: z.string().min(1),
    description: z.string().default(""), defaultRef: z.string().min(1),
    sourcePath: absolutePath.optional(),
  })).default([]),
});
const schema = z.object({
  workspaces: z.array(workspaceSchema).min(1),
  groupBindings: z.array(z.object({ chatId: z.string().min(1), workspaceId: z.string().min(1) })).default([]),
  privateBinding: z.object({
    chatId: z.string().min(1), ownerOpenId: z.string().min(1), workspaceId: z.string().min(1),
  }),
  maxAttachmentBytes: z.number().int().positive().max(100 * 1024 * 1024).default(20 * 1024 * 1024),
  agentEnvironment: z.record(z.string(), z.string()).default({}),
}).superRefine((value, ctx) => {
  const ids = new Set(value.workspaces.map((w) => w.id));
  const chats = value.groupBindings.map((g) => g.chatId);
  if (ids.size !== value.workspaces.length || new Set(chats).size !== chats.length || chats.includes(value.privateBinding.chatId)) {
    ctx.addIssue({ code: "custom", message: "duplicate workspace or chat binding" });
  }
  for (const binding of [...value.groupBindings, value.privateBinding]) {
    if (!ids.has(binding.workspaceId)) ctx.addIssue({ code: "custom", message: "unknown workspace binding" });
  }
  for (const key of Object.keys(value.agentEnvironment)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /FEISHU|LARK|TOKEN|SECRET|PASSWORD|KEY|NODE_OPTIONS|LD_|DYLD_|HOME|PATH/.test(key)) {
      ctx.addIssue({ code: "custom", message: "agentEnvironment allows only non-secret tool configuration variables" });
    }
  }
});

export type OncallConfig = z.infer<typeof schema>;
export type BusinessWorkspace = z.infer<typeof workspaceSchema>;

export function loadOncallConfig(file: string): OncallConfig {
  try { return schema.parse(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch { throw new Error("Invalid Oncall configuration; check bindings, container paths and tool environment"); }
}

export function resolveWorkspace(config: OncallConfig, event: FeishuMessageEvent): BusinessWorkspace | undefined {
  const { message, sender } = event;
  if (sender.sender_type !== "user") return;
  const binding = message.chat_type === "p2p"
    ? (message.chat_id === config.privateBinding.chatId && sender.sender_id?.open_id === config.privateBinding.ownerOpenId ? config.privateBinding : undefined)
    : message.chat_type === "group" ? config.groupBindings.find((b) => b.chatId === message.chat_id) : undefined;
  return config.workspaces.find((w) => w.id === binding?.workspaceId);
}
