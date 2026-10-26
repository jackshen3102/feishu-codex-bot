#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import { setTimeout } from "node:timers";

// The SDK signals only its immediate child. Keep a supervisor outside Codex's
// POSIX process group so cancellation also reaches its shell/tool descendants.
const binary = process.env.FEISHU_CODEX_BINARY;
if (!binary) {
  process.stderr.write("Bundled Codex CLI is unavailable.\n");
  process.exit(127);
}

let args = process.argv.slice(2);
if (process.env.FEISHU_AGENT_BACKEND === "traex") {
  // TRAE exposes the same JSONL exec protocol with different CLI flag names.
  args = args.flatMap((arg, index) => arg === "--thread-source" || args[index - 1] === "--thread-source" ? [] : [arg === "--experimental-json" ? "--json" : arg]);
  args.unshift("--no-daemon");
}
const child = spawn(binary, args, {
  detached: true,
  stdio: "inherit",
  env: process.env,
});
let stopping = false;
let exitCode = 1;

function signalGroup(signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) {
    if (error.code !== "ESRCH") child.kill(signal);
  }
}

function stop(code) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  signalGroup("SIGTERM");
  // Unlike the fire-and-forget helper, keep this timer referenced: the leader
  // may exit before a TERM-resistant descendant. Do not release the SDK turn
  // until the group has received the final signal.
  setTimeout(() => {
    signalGroup("SIGKILL");
    process.exit(exitCode);
  }, 500);
}

for (const [signal, code] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]]) {
  process.on(signal, () => stop(code));
}
child.once("error", () => {
  process.stderr.write("Unable to start bundled Codex CLI.\n");
  stop(127);
});
child.once("exit", (code, signal) => {
  // Also reap background tools left by a normally completed Codex process.
  if (!stopping) stop(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1));
});
