import type { ConfigureWeb } from "./web/auth.js";
import { loadConfig } from "./config.js";
import { Gateway } from "./gateway.js";
import { startOptionalWeb } from "./web/lifecycle.js";
import { errorKind, logger } from "./logging.js";

export async function startApplication(options: { configureWeb?: ConfigureWeb } = {}): Promise<void> {
  const config = loadConfig();
  const gateway = await Gateway.create(config);
  await gateway.start();

  let web: Awaited<ReturnType<typeof startOptionalWeb>> = null;
  let stopping: Promise<void> | undefined;
  let signalled = false;
  const handleSignal = (): void => {
    signalled = true;
    stopping ??= (async () => {
      try { await web?.close(); } finally { await gateway.stop(); }
    })();
    void stopping.catch((error) => {
      logger.error("service_stop_failed", { errorKind: errorKind(error) });
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", handleSignal);
  process.once("SIGINT", handleSignal);
  web = await startOptionalWeb(config, process.env, gateway.agentControl, options.configureWeb);
  if (signalled) await web?.close();
}

