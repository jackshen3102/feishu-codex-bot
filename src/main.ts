import { startApplication } from "./bootstrap.js";
import { errorKind, logger } from "./logging.js";

try { await startApplication(); }
catch (error) {
  logger.error("service_start_failed", { errorKind: errorKind(error) });
  process.exitCode = 1;
}
