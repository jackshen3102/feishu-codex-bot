import type { ConfigureWeb } from "./auth.js";
import type { AgentControl } from "../agent/settings.js";
import type { AppConfig } from "../config.js";
import { loadOncallConfig } from "../oncall/workspace-config.js";
import { errorKind, logger } from "../logging.js";
import { loadWebConfig } from "./config.js";
import { startWebServer, type WebServer } from "./server.js";

export async function startOptionalWeb(config: AppConfig, environment: NodeJS.ProcessEnv = process.env, agentControl?: AgentControl, configureWeb?: ConfigureWeb): Promise<WebServer | null> {
  try {
    const configured = configureWeb ? configureWeb(environment) : { config: loadWebConfig(environment) };
    const web = configured.config; if (!web) return null;
    if (!config.ONCALL_CONFIG_PATH) throw new Error("Web requires Oncall configuration");
    const server = await startWebServer({ config: web, authentication: configured.authentication, databasePath: config.STATE_DB_PATH, oncall: loadOncallConfig(config.ONCALL_CONFIG_PATH), maxConcurrentTurns: config.MAX_CONCURRENT_TURNS, agentControl });
    logger.info("management_web_started"); return server;
  } catch (error) { logger.error("management_web_unavailable", { errorKind: errorKind(error) }); return null; }
}
