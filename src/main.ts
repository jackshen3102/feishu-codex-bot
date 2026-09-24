import { loadConfig } from "./config.js";
import { Gateway } from "./gateway.js";
import { errorKind, logger } from "./logging.js";

async function main(): Promise<void> {
  const gateway = await Gateway.create(loadConfig());
  await gateway.start();

  const handleSignal = (): void => {
    void gateway.stop().catch((error) => {
      logger.error("service_stop_failed", { errorKind: errorKind(error) });
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", handleSignal);
  process.once("SIGINT", handleSignal);
}

try {
  await main();
} catch (error) {
  logger.error("service_start_failed", { errorKind: errorKind(error) });
  process.exitCode = 1;
}
