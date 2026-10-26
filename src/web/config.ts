import { z } from "zod";

const schema = z.object({
  WEB_HOST: z.enum(["127.0.0.1", "::1", "0.0.0.0"]).default("127.0.0.1"),
  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(6193),
});
export interface WebConfig { host: string; port: number; authenticationRequired?: boolean }

export function loadWebConfig(environment: NodeJS.ProcessEnv = process.env): WebConfig | null {
  if (environment.WEB_ENABLED === undefined || environment.WEB_ENABLED === "false") return null;
  if (environment.WEB_ENABLED !== "true") throw new Error("Invalid Web enabled flag");
  // Old authenticated deployments must select an authentication-enabled entrypoint.
  if (environment.WEB_SSO_ENABLED !== undefined && environment.WEB_SSO_ENABLED !== "false") {
    throw new Error("Authentication requires a configured integration entrypoint");
  }
  if (environment.WEB_AUTH_REQUIRED !== undefined && !["true", "false"].includes(environment.WEB_AUTH_REQUIRED)) {
    throw new Error("Invalid Web authentication requirement");
  }
  const config = schema.parse(environment);
  return { host: config.WEB_HOST, port: config.WEB_PORT,
    ...(environment.WEB_AUTH_REQUIRED === "true" ? { authenticationRequired: true } : {}) };
}
