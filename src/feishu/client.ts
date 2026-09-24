import {
  Client,
  EventDispatcher,
  LoggerLevel,
  WSClient,
  type EventHandles,
  type Logger,
} from "@larksuiteoapi/node-sdk";
import type { AppConfig } from "../config.js";
import type { FeishuMessageEvent } from "../contracts.js";
import { logger } from "../logging.js";

interface BotInfoResponse {
  code?: number;
  msg?: string;
  bot?: { open_id?: string };
}

const safeSdkLogger: Logger = {
  error: () => logger.error("feishu_sdk_error", { errorKind: "FeishuSdkError" }),
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

export function createLarkClient(config: AppConfig): Client {
  return new Client({
    appId: config.FEISHU_APP_ID,
    appSecret: config.FEISHU_APP_SECRET,
    logger: safeSdkLogger,
    loggerLevel: LoggerLevel.error,
  });
}

export async function resolveBotOpenId(client: Client): Promise<string> {
  const response = await client.request<BotInfoResponse>({ method: "GET", url: "/open-apis/bot/v3/info" });
  if ((response.code ?? 0) !== 0 || !response.bot?.open_id) {
    throw new Error(`bot identity lookup failed with application code ${response.code ?? "unknown"}`);
  }
  return response.bot.open_id;
}

export class FeishuWebSocket {
  private readonly dispatcher: EventDispatcher;
  private readonly socket: WSClient;

  constructor(config: AppConfig, handler: (event: FeishuMessageEvent) => Promise<void>) {
    this.dispatcher = new EventDispatcher({ logger: safeSdkLogger, loggerLevel: LoggerLevel.error }).register({
      "im.message.receive_v1": handler,
    } satisfies EventHandles);
    this.socket = new WSClient({
      appId: config.FEISHU_APP_ID,
      appSecret: config.FEISHU_APP_SECRET,
      logger: safeSdkLogger,
      loggerLevel: LoggerLevel.error,
      autoReconnect: true,
    });
  }

  async start(): Promise<void> {
    await this.socket.start({ eventDispatcher: this.dispatcher });
  }

  close(): void {
    this.socket.close({ force: false });
  }
}
