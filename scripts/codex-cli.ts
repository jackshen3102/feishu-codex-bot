import { spawn } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { buildCodexEnvironment, resolveBundledCodexRuntime } from "../src/codex/runner.js";

// Use the exact bundled CLI and environment used by jobs, including its dedicated home.
const config = loadConfig();
const child = spawn(resolveBundledCodexRuntime().binary, process.argv.slice(2), {
  env: buildCodexEnvironment(config),
  stdio: "inherit",
});
child.once("error", () => {
  process.stderr.write("Unable to start bundled Codex CLI\n");
  process.exitCode = 1;
});
child.once("exit", (code) => { process.exitCode = code ?? 1; });
