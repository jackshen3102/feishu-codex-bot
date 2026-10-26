import type { IncomingMessage } from "node:http";
import type { WebConfig } from "./config.js";

export interface WebUser { email: string; username: string; avatarUrl: string | null }
export interface WebRequest extends IncomingMessage { user: WebUser | null }

/** Explicitly supplied by the host application; never discovered from request data. */
export interface WebAuthentication {
  publicOrigin: string;
  allowedEmails: readonly string[];
  verify: (request: IncomingMessage) => Promise<WebUser>;
  sessionModule: string;
  assets?: ReadonlyArray<{ route: string; file: string; type: string }>;
  clientConfig?: Readonly<Record<string, unknown>>;
  browserSources?: readonly string[];
}

export type ConfigureWeb = (environment: NodeJS.ProcessEnv) => {
  config: WebConfig | null;
  authentication?: WebAuthentication;
};
