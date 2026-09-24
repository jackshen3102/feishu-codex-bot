import type { TrustedFeishuInput } from "../contracts.js";

export function buildTrustedPrompt(input: TrustedFeishuInput): string {
  return JSON.stringify(input);
}
