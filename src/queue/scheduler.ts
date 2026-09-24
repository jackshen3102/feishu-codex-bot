import { ProgressWindow } from "../agent/progress.js";
import type { AgentProgressReporter, TurnRunner } from "../agent/runner.js";
import { containsProtectedCredential, type AppConfig } from "../config.js";
import type { Job, TurnReply } from "../contracts.js";
import type { Store } from "../db/store.js";
import { INTERRUPTED_RESULT_TEXT } from "../jobs/status-view.js";
import { errorKind, logger } from "../logging.js";
import type { WorkspaceManager } from "../workspaces.js";
import { claimTopicFifo } from "./topic-fifo.js";

const FAILURE_REPLY = "任务失败，请回复重试。";
const AUTHENTICATION_FAILURE_REPLY = "Agent 未登录或登录已失效，请联系管理员为 Bot 服务账号重新登录并通过调用检查后，再重试任务。";
const FIRST_PROGRESS_DELAY_MS = 60_000;
const PROGRESS_INTERVAL_MS = 300_000;
const EVENT_PROGRESS_INTERVAL_MS = 10_000;

function waitForDelay(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, milliseconds);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class Scheduler {
  private active = 0;
  private running = false;
  private pumping = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly runner: TurnRunner,
    private readonly workspaces: WorkspaceManager,
    private readonly notifyDeliveries: () => void = () => undefined,
    private readonly progressTiming: { firstDelayMs: number; intervalMs: number; eventIntervalMs?: number } = {
      firstDelayMs: FIRST_PROGRESS_DELAY_MS,
      intervalMs: PROGRESS_INTERVAL_MS,
    },
  ) {}

  async start(): Promise<void> {
    this.running = true;
    this.wake();
  }

  stop(): void {
    this.running = false;
    this.runner.abortAll();
    this.resolveIdleIfNeeded();
  }

  wake(): void {
    if (!this.running || this.pumping) return;
    this.pumping = true;
    queueMicrotask(() => {
      void this.pump().catch((error) => {
        logger.error("scheduler_pump_failed", { errorKind: errorKind(error) });
      });
    });
  }

  async waitForIdle(): Promise<void> {
    if (
      this.active === 0 &&
      (!this.running || !this.store.hasRunnableJobs())
    ) {
      return;
    }
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private async pump(): Promise<void> {
    try {
      while (this.running && this.active < this.config.MAX_CONCURRENT_TURNS) {
        const capacity = this.config.MAX_CONCURRENT_TURNS - this.active;
        const jobs = claimTopicFifo(this.store, capacity);
        if (jobs.length === 0) break;
        this.notifyDeliveries();
        for (const job of jobs) {
          this.active += 1;
          void this.execute(job).finally(() => {
            this.active -= 1;
            this.resolveIdleIfNeeded();
            this.wake();
          });
        }
      }
    } finally {
      this.pumping = false;
      this.resolveIdleIfNeeded();
    }
  }

  private async execute(job: Job): Promise<void> {
    const started = Date.now();
    const topic = this.store.getTopic(job.topicId);
    if (!topic) return;
    const beforeRun = this.store.getJob(job.id);
    if (beforeRun?.executionStatus === "cancel_requested") {
      this.store.confirmCancellation(job.id);
      this.notifyDeliveries();
      return;
    }

    const progressController = new AbortController();
    const elapsedProgress = this.reportElapsedProgress(job, progressController.signal);
    const eventProgress = this.createEventProgress(job);
    let turnResult: TurnReply = { status: "failed", reply: FAILURE_REPLY };
    let failureKind: string | null;
    try {
      await this.workspaces.ensure(topic.workspacePath);
      if (this.store.getJob(job.id)?.executionStatus === "cancel_requested") {
        this.store.confirmCancellation(job.id);
        this.notifyDeliveries();
        return;
      }
      if (!this.running) {
        this.store.interruptExecution(job.id, INTERRUPTED_RESULT_TEXT);
        this.notifyDeliveries();
        return;
      }
      const result = await this.runner.run(
        job,
        topic,
        eventProgress.report,
        (sessionId) => this.store.setAgentSessionId(topic.id, sessionId),
      );
      const protectedOutput = containsProtectedCredential(this.config, result.reply);
      turnResult = protectedOutput ? { status: "failed", reply: FAILURE_REPLY } : result;
      failureKind = result.status === "failed" ? "agent_failed" : protectedOutput ? "protected_output" : null;
    } catch (error) {
      failureKind = errorKind(error);
      if (failureKind === "AgentAuthenticationError") {
        turnResult = { status: "failed", reply: AUTHENTICATION_FAILURE_REPLY };
      }
    } finally {
      progressController.abort();
      await elapsedProgress;
      eventProgress.flushAndStop();
    }

    let final = this.store.getJob(job.id);
    if (final?.executionStatus === "cancel_requested") {
      final = this.store.confirmCancellation(job.id).job;
    } else if (!this.running && final?.executionStatus === "running") {
      final = this.store.interruptExecution(job.id, INTERRUPTED_RESULT_TEXT).job;
    } else {
      const completion = this.store.completeExecution(job.id, turnResult, failureKind);
      if (completion.kind === "cancel_requested") final = this.store.confirmCancellation(job.id).job;
      else final = completion.job;
    }
    this.notifyDeliveries();
    logger.info("job_finished", {
      jobId: job.id,
      topicId: job.topicId,
      status: final?.executionStatus,
      version: final?.statusVersion,
      durationMs: Date.now() - started,
      errorKind: failureKind ?? undefined,
    });
  }

  private async reportElapsedProgress(job: Job, signal: AbortSignal): Promise<void> {
    let delay = this.progressTiming.firstDelayMs;
    while (await waitForDelay(delay, signal)) {
      if (!this.store.markStatusDirty(job.id)) return;
      this.notifyDeliveries();
      delay = this.progressTiming.intervalMs;
    }
  }

  private createEventProgress(job: Job): { report: AgentProgressReporter; flushAndStop: () => void } {
    const window = new ProgressWindow();
    const intervalMs = this.progressTiming.eventIntervalMs ?? EVENT_PROGRESS_INTERVAL_MS;
    let dirty = false;
    let lastFlushAt = 0;
    let timer: NodeJS.Timeout | null = null;

    const flush = (): void => {
      if (!dirty) return;
      dirty = false;
      lastFlushAt = Date.now();
      if (this.store.updateProgress(job.id, window.snapshot())) this.notifyDeliveries();
    };
    const report: AgentProgressReporter = (update) => {
      const protectedProgress = containsProtectedCredential(
        this.config,
        [update.title, update.detail ?? ""].join("\n"),
      );
      if (protectedProgress || !window.apply(update)) return;
      dirty = true;
      const remaining = Math.max(0, intervalMs - (Date.now() - lastFlushAt));
      if (lastFlushAt === 0 || remaining === 0) {
        if (timer) clearTimeout(timer);
        timer = null;
        flush();
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          flush();
        }, remaining);
        timer.unref();
      }
    };
    return {
      report,
      flushAndStop: () => {
        if (timer) clearTimeout(timer);
        timer = null;
        flush();
      },
    };
  }

  private resolveIdleIfNeeded(): void {
    if (this.active !== 0) return;
    if (!this.running) {
      for (const resolve of this.idleWaiters.splice(0)) resolve();
      return;
    }
    if (this.store.hasRunnableJobs()) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}
