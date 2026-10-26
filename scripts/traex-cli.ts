import { spawn } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { buildTraexEnvironment } from "../src/agent/factory.js";

// Operator login uses the same dedicated home and environment as TRAE jobs.
const config = loadConfig();
const child = spawn(config.TRAEX_BINARY ?? "traex", process.argv.slice(2), {
  env: buildTraexEnvironment(config), stdio: "inherit",
});
child.once("error", () => { process.stderr.write("Unable to start TRAE CLI\n"); process.exitCode = 1; });
child.once("exit", code => { process.exitCode = code ?? 1; });
