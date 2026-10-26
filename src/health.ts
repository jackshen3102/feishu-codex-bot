import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Store } from "./db/store.js";

const MAX_HEALTH_FILE_BYTES = 64 * 1024;
const DEFAULT_FRESHNESS_MS = 90_000;

const healthStatusSchema = z.object({
  version: z.literal(1),
  sampledAt: z.string().datetime(),
  service: z.object({
    state: z.enum(["starting", "running", "stopping", "stopped"]),
    startedAt: z.string().datetime(),
    lastIngressAt: z.string().datetime().nullable(),
  }).strict(),
  schemaVersion: z.number().int().nonnegative(),
  backend: z.enum(["codex", "traex"]),
  lastExecution: z.object({
    jobId: z.number().int().positive(),
    status: z.enum(["succeeded", "failed", "cancelled", "interrupted"]),
    errorKind: z.string().nullable(),
    finishedAt: z.string().datetime(),
  }).strict().nullable().optional(),
  jobs: z.object({
    preparing: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    cancelRequested: z.number().int().nonnegative(),
    oldestQueuedAt: z.string().datetime().nullable(),
  }).strict(),
  deliveries: z.object({
    pending: z.number().int().nonnegative(),
    delivering: z.number().int().nonnegative(),
    abandoned: z.number().int().nonnegative(),
    lastSuccessfulAt: z.string().datetime().nullable(),
  }).strict(),
  databaseBytes: z.number().int().nonnegative(),
}).strict();

export type ServiceState = "starting" | "running" | "stopping" | "stopped";
export type HealthStatus = z.infer<typeof healthStatusSchema>;
export type ReadHealthStatus = HealthStatus & {
  sampleAgeMs: number;
  sampleStatus: "fresh" | "stale";
};

export function healthStatusPath(databasePath: string): string {
  return path.join(path.dirname(databasePath), "health.json");
}

async function writeHealthStatus(filePath: string, status: HealthStatus): Promise<void> {
  try {
    if ((await fs.lstat(filePath)).isSymbolicLink()) throw new Error("health status path cannot be a symbolic link");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await fs.open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(status)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

export class HealthReporter {
  private readonly startedAt = new Date().toISOString();
  private lastIngressAt: string | null = null;
  private state: ServiceState = "starting";
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: Store,
    private readonly filePath: string,
  ) {}

  markIngress(timestamp = new Date().toISOString()): void {
    this.lastIngressAt = timestamp;
  }

  publish(state: ServiceState = this.state): Promise<void> {
    this.state = state;
    this.pending = this.pending.catch(() => undefined).then(async () => {
      const snapshot = this.store.operationalSnapshot();
      await writeHealthStatus(this.filePath, {
        version: 1,
        sampledAt: new Date().toISOString(),
        service: {
          state: this.state,
          startedAt: this.startedAt,
          lastIngressAt: this.lastIngressAt,
        },
        ...snapshot,
      });
    });
    return this.pending;
  }
}

export async function readHealthStatus(
  filePath: string,
  referenceTime = Date.now(),
  freshnessMs = DEFAULT_FRESHNESS_MS,
): Promise<ReadHealthStatus> {
  const metadata = await fs.lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_HEALTH_FILE_BYTES) {
    throw new Error("health status file is unsafe");
  }
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_HEALTH_FILE_BYTES) throw new Error("health status file is unsafe");
    const status = healthStatusSchema.parse(JSON.parse(await handle.readFile("utf8")));
    const sampleAgeMs = Math.max(0, referenceTime - Date.parse(status.sampledAt));
    return {
      ...status,
      sampleAgeMs,
      sampleStatus: sampleAgeMs <= freshnessMs ? "fresh" : "stale",
    };
  } finally {
    await handle.close();
  }
}
