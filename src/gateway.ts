import fs from "node:fs/promises";
import path from "node:path";
import { createTurnRunner } from "./agent/factory.js";
import { activeAgentHome, type AppConfig } from "./config.js";
import { CancellationController } from "./control/cancellation.js";
import { Store } from "./db/store.js";
import { OutboxWorker } from "./delivery/outbox-worker.js";
import { createLarkClient, FeishuWebSocket, resolveBotOpenId } from "./feishu/client.js";
import { FeishuIngress } from "./feishu/ingress.js";
import { LarkFeishuDelivery } from "./feishu/messages.js";
import { HealthReporter, healthStatusPath } from "./health.js";
import { errorKind, logger } from "./logging.js";
import { Scheduler } from "./queue/scheduler.js";
import { WorkspaceManager } from "./workspaces.js";

const MAINTENANCE_INTERVAL_MS = 86_400_000;
const HEALTH_INTERVAL_MS = 30_000;

export class Gateway {
  private cleanupTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private stopPromise: Promise<void> | null = null;
  private closed = false;

  private constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly health: HealthReporter,
    private readonly workspaces: WorkspaceManager,
    private readonly outbox: OutboxWorker,
    private readonly scheduler: Scheduler,
    private readonly webSocket: FeishuWebSocket,
  ) {}

  static async create(config: AppConfig): Promise<Gateway> {
    await Promise.all([
      fs.mkdir(activeAgentHome(config), { recursive: true, mode: 0o700 }),
      fs.mkdir(config.WORKSPACE_ROOT, { recursive: true, mode: 0o700 }),
    ]);

    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT, config.AGENT_BACKEND);
    const health = new HealthReporter(store, healthStatusPath(config.STATE_DB_PATH));
    try {
      await health.publish("starting");
      const workspaces = new WorkspaceManager(config.WORKSPACE_ROOT, path.join(process.cwd(), "workspace-template"));
      await workspaces.initialize();
      await workspaces.cleanup(store, config.WORKSPACE_RETENTION_DAYS);
      await Gateway.recover(store, workspaces, config.JOB_RETENTION_DAYS);

      const runner = createTurnRunner(config);
      const larkClient = createLarkClient(config);
      const delivery = new LarkFeishuDelivery(larkClient, config.FEISHU_APP_ID);
      const botOpenId = await resolveBotOpenId(larkClient);
      const outbox = new OutboxWorker(store, delivery);
      const scheduler = new Scheduler(config, store, runner, workspaces, () => outbox.wake());
      const cancellation = new CancellationController(store, runner, delivery, () => {
        scheduler.wake();
        outbox.wake();
      });
      const signals = {
        executionReady: () => scheduler.wake(),
        deliveryReady: () => outbox.wake(),
      };
      const ingress = new FeishuIngress(
        config,
        botOpenId,
        store,
        delivery,
        signals,
        workspaces,
        cancellation,
      );
      const webSocket = new FeishuWebSocket(config, async (event) => {
        health.markIngress();
        await ingress.handle(event);
      });
      return new Gateway(config, store, health, workspaces, outbox, scheduler, webSocket);
    } catch (error) {
      await health.publish("stopped").catch(() => undefined);
      store.close();
      throw error;
    }
  }

  async start(): Promise<void> {
    try {
      this.outbox.start();
      await this.scheduler.start();
      await this.webSocket.start();
      await this.health.publish("running");
    } catch (error) {
      this.webSocket.close();
      this.scheduler.stop();
      await this.outbox.stop();
      await this.health.publish("stopped").catch(() => undefined);
      this.store.close();
      this.closed = true;
      throw error;
    }

    this.cleanupTimer = setInterval(() => void this.maintain(), MAINTENANCE_INTERVAL_MS);
    this.cleanupTimer.unref();
    this.healthTimer = setInterval(() => {
      void this.health.publish().catch((error) => {
        logger.error("health_snapshot_failed", { errorKind: errorKind(error) });
      });
    }, HEALTH_INTERVAL_MS);
    this.healthTimer.unref();
    logger.info("service_started");
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private static async recover(store: Store, workspaces: WorkspaceManager, retentionDays: number): Promise<void> {
    const recovered = store.recoverUncertainExecutions();
    store.pruneTerminalJobs(new Date(Date.now() - retentionDays * 86_400_000).toISOString());
    await Promise.all(
      recovered
        .filter((item) => item.previousStatus === "preparing")
        .map(async ({ job }) => {
          const topic = store.getTopic(job.topicId);
          if (!topic) return;
          await workspaces.removeInputImages(
            topic.workspacePath,
            [job.feishuMessageId, job.referencedMessageId].filter((item): item is string => Boolean(item)),
          );
        }),
    );
  }

  private async maintain(): Promise<void> {
    try {
      await this.workspaces.cleanup(this.store, this.config.WORKSPACE_RETENTION_DAYS);
      const removed = this.store.pruneTerminalJobs(
        new Date(Date.now() - this.config.JOB_RETENTION_DAYS * 86_400_000).toISOString(),
      );
      if (removed > 0) logger.info("terminal_jobs_pruned", { count: removed });
    } catch (error) {
      logger.error("maintenance_failed", { errorKind: errorKind(error) });
    }
  }

  private async stopOnce(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    await this.health.publish("stopping");
    logger.info("service_stopping");
    this.webSocket.close();
    this.scheduler.stop();
    const outboxStop = this.outbox.stop();
    await this.scheduler.waitForIdle();
    await outboxStop;
    await this.health.publish("stopped");
    this.store.close();
    logger.info("service_stopped");
  }
}
