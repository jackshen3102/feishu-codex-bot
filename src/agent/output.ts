import { z } from "zod";
import type { TurnReply } from "../contracts.js";

export const turnOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "reply"],
  properties: {
    status: { type: "string", enum: ["succeeded", "failed"] },
    reply: { type: "string", minLength: 1 },
  },
} as const;

export const FORMAT_CORRECTION_PROMPT =
  "Do not repeat any tools or task actions. Only restate your immediately preceding final result as one JSON object matching the required output schema.";

const turnReplySchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  reply: z.string().trim().min(1).max(100_000),
}).strict();

export function parseTurnReply(value: string): TurnReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Agent final response was not JSON");
  }
  return turnReplySchema.parse(parsed);
}
