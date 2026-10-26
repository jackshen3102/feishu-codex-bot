import { z } from "zod";
import type { TurnReply } from "../contracts.js";
import { caseSchema } from "../oncall/case-store.js";

export const turnOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "reply"],
  properties: {
    status: { type: "string", enum: ["succeeded", "failed"] },
    reply: { type: "string", minLength: 1 },
  },
} as const;

// Keep the legacy reply contract unchanged. Oncall additionally records a case;
// null is valid when the turn contains no useful case information.
export const oncallTurnOutputSchema = {
  ...turnOutputSchema,
  required: ["status", "reply", "caseSummary"],
  properties: {
    ...turnOutputSchema.properties,
    caseSummary: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["summary", "conclusions", "evidence"],
          properties: {
            summary: { type: "string", maxLength: 4000 },
            conclusions: {
              type: "array", maxItems: 30,
              items: {
                type: "object", additionalProperties: false,
                required: ["text", "verification"],
                properties: {
                  text: { type: "string", maxLength: 4000 },
                  verification: { type: "string", enum: ["observed", "verified", "unverified"] },
                },
              },
            },
            evidence: { type: "array", maxItems: 40, items: { type: "string", maxLength: 4000 } },
          },
        },
      ],
    },
  },
} as const;

export const FORMAT_CORRECTION_PROMPT =
  "Do not repeat any tools or task actions. Only restate your immediately preceding final result as one JSON object matching the required output schema.";

const turnReplySchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  reply: z.string().trim().min(1).max(100_000),
  caseSummary: z.unknown().optional(),
}).strict();

export function parseTurnReply(value: string): TurnReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Agent final response was not JSON");
  }
  const { caseSummary, ...reply } = turnReplySchema.parse(parsed);
  const validatedCase = caseSchema.safeParse(caseSummary);
  // Case extraction is best effort. A malformed summary must never discard a
  // valid answer or ask the Agent to repeat already performed task actions.
  return validatedCase.success ? { ...reply, caseSummary: validatedCase.data } : reply;
}
