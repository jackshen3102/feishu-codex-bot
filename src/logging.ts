type LogLevel = "info" | "warn" | "error";

export interface SafeLogFields {
  messageId?: string;
  topicId?: string;
  jobId?: number;
  attempt?: number;
  terminal?: boolean;
  sequence?: number;
  version?: number;
  status?: string;
  durationMs?: number;
  count?: number;
  errorKind?: string;
}

function emit(level: LogLevel, event: string, fields: SafeLogFields = {}): void {
  const record = { timestamp: new Date().toISOString(), level, event, ...fields };
  const output = JSON.stringify(record);
  if (level === "error") console.error(output);
  else console.log(output);
}

export const logger = {
  info: (event: string, fields?: SafeLogFields) => emit("info", event, fields),
  warn: (event: string, fields?: SafeLogFields) => emit("warn", event, fields),
  error: (event: string, fields?: SafeLogFields) => emit("error", event, fields),
};

export function errorKind(error: unknown): string {
  if (error instanceof Error) {
    const categories: Record<string, string> = {
      AbortError: "AbortError",
      AgentAuthenticationError: "AgentAuthenticationError",
      ConfigError: "ConfigError",
      DocStageError: "DocStageError",
      Error: "OperationError",
      PreflightError: "PreflightError",
      RangeError: "RuntimeError",
      SqliteError: "DatabaseError",
      SyntaxError: "RuntimeError",
      TurnTimeoutError: "TurnTimeoutError",
      TypeError: "RuntimeError",
      ZodError: "ValidationError",
    };
    return categories[error.name] ?? "OperationError";
  }
  return "UnknownError";
}
