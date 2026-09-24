import type { ChildProcess } from "node:child_process";

const DEFAULT_KILL_GRACE_MS = 500;

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Terminate a child that was spawned as the leader of a detached POSIX process group. */
export function terminateProcessTree(
  child: ChildProcess,
  graceMs = DEFAULT_KILL_GRACE_MS,
): void {
  const pid = child.pid;
  if (!pid) {
    child.kill("SIGTERM");
    return;
  }

  if (process.platform === "win32") {
    child.kill("SIGTERM");
    return;
  }

  if (!signalProcessGroup(pid, "SIGTERM")) child.kill("SIGTERM");
  const forceKill = setTimeout(() => {
    if (!signalProcessGroup(pid, "SIGKILL")) child.kill("SIGKILL");
  }, graceMs);
  forceKill.unref();
}
