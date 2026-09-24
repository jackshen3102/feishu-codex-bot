import path from "node:path";
import { healthStatusPath, readHealthStatus } from "./health.js";

function resolveStatusFile(argument: string | undefined, environment: NodeJS.ProcessEnv): string {
  if (argument) {
    if (!path.isAbsolute(argument)) throw new Error("health status path must be absolute");
    return argument;
  }
  const databasePath = environment.STATE_DB_PATH;
  if (!databasePath || !path.isAbsolute(databasePath)) throw new Error("STATE_DB_PATH must be an absolute path");
  return healthStatusPath(databasePath);
}

const arguments_ = process.argv.slice(2);
if (arguments_[0] === "--") arguments_.shift();

if (arguments_[0] === "--help") {
  process.stdout.write("Usage: pnpm status -- [absolute-health-json-path]\n");
} else {
  try {
    if (arguments_.length > 1) throw new Error("too many status arguments");
    const status = await readHealthStatus(resolveStatusFile(arguments_[0], process.env));
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ status: "unavailable", error: "health status unavailable" })}\n`);
    process.exitCode = 1;
  }
}
