import { startWebServer, type WebServerOptions } from "./server.js";
import type { WebAuthentication } from "./auth.js";

/** An authenticated read-only entrypoint. It never constructs the gateway. */
export function startStandaloneWeb(options: Omit<WebServerOptions, "agentControl"> & { authentication: WebAuthentication }) {
  // Discard control even if a JavaScript caller supplies it outside the type contract.
  const { config, authentication, databasePath, oncall, maxConcurrentTurns, publicDirectory } = options;
  return startWebServer({ config: { ...config, authenticationRequired: true }, authentication,
    databasePath, oncall, maxConcurrentTurns, publicDirectory });
}
