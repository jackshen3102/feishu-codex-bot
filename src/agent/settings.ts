import { z } from "zod";

export const agentSettingsSchema = z.object({
  backend: z.enum(["codex", "traex"]),
  model: z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/).nullable(),
}).strict();
export type AgentSettings = z.infer<typeof agentSettingsSchema>;
export interface AgentControl {
  get: () => AgentSettings;
  set: (settings: AgentSettings) => AgentSettings;
}
