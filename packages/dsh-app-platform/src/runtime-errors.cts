export type LocalAppRuntimeErrorCode =
  | "action_timeout"
  | "action_resource_limit"
  | "action_runtime_error"
  | "action_concurrency_timeout"
  | "db_runtime_error"
  | "db_runtime_restart_required"
  | "db_contract_error"
  | "db_queue_timeout"
  | "named_sql_result_too_large";

export interface LocalAppRuntimeErrorDetails {
  [key: string]: unknown;
}

export class LocalAppRuntimeError extends Error {
  status: number;
  code: LocalAppRuntimeErrorCode;
  details?: LocalAppRuntimeErrorDetails;
  override cause?: unknown;

  constructor(
    message: string,
    options: {
      status?: number;
      code: LocalAppRuntimeErrorCode;
      details?: LocalAppRuntimeErrorDetails;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "LocalAppRuntimeError";
    this.status = options.status ?? 500;
    this.code = options.code;
    this.details = options.details;
    this.cause = options.cause;
  }
}

export function isWasmRuntimeError(err: unknown): boolean {
  if (typeof WebAssembly !== "undefined" && err instanceof WebAssembly.RuntimeError) return true;
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (/memory access out of bounds|wasm|webassembly/i.test(message)) return true;
  const stack = err instanceof Error ? err.stack ?? "" : "";
  return /sql-wasm\.js/i.test(stack) && (message.trim() === "" || message.includes("\uFFFD"));
}

export function summarizeError(err: unknown): LocalAppRuntimeErrorDetails {  if (err instanceof Error) {
    return {
      originalName: err.name,
      originalMessage: err.message,
    };
  }
  return {
    originalMessage: String(err ?? "Unknown error"),
  };
}

export function wrapDatabaseRuntimeError(
  err: unknown,
  context: {
    operation: "query" | "mutation" | "transaction" | "raw";
    sqlName?: string;
    dbPath?: string;
  },
): LocalAppRuntimeError {
  return new LocalAppRuntimeError("Database runtime error while executing hosted data operation", {
    status: 500,
    code: "db_runtime_error",
    cause: err,
    details: {
      operation: context.operation,
      sqlName: context.sqlName,
      ...summarizeError(err),
    },
  });
}

export function wrapDatabaseContractError(
  err: unknown,
  context: {
    operation: "query" | "mutation";
    sqlName: string;
  },
): LocalAppRuntimeError {
  return new LocalAppRuntimeError("Database contract error while executing named SQL", {
    status: 400,
    code: "db_contract_error",
    cause: err,
    details: {
      operation: context.operation,
      sqlName: context.sqlName,
      ...summarizeError(err),
    },
  });
}

type SqlJsRuntimeStopHook = (reason: string) => void;

let sqlJsRuntimeStop: SqlJsRuntimeStopHook | undefined;
let sqlJsRuntimeStopReason: string | undefined;

/** Tests observe the stop instead of ending the process under test. */
export function setSqlJsRuntimeStopHook(hook: SqlJsRuntimeStopHook | undefined): void {
  sqlJsRuntimeStop = hook;
}

export function isSqlJsRuntimeUnusable(): boolean {
  return sqlJsRuntimeStopReason !== undefined;
}

/**
 * A WebAssembly trap tears the Emscripten module instance, and `initSqlJs()`
 * hands that same instance back on every later call — so re-opening a database
 * in this process traps again on the next `new SQL.Database(...)`. Recovery
 * therefore cannot be in-process: the trap is terminal, and the process stops
 * (non-zero) so whatever supervises it starts a clean one. Serving requests on
 * the poisoned instance is what turned a single trap into every database
 * request failing until an unguarded timer callback finally killed the process.
 */
export function markSqlJsRuntimeUnusable(err: unknown, scope: string): LocalAppRuntimeError {
  const fatal = new LocalAppRuntimeError(
    `The LocalApp SQLite runtime is unusable after a WebAssembly trap in ${scope}; the Server must restart`,
    {
      status: 503,
      code: "db_runtime_restart_required",
      cause: err,
      details: { scope, ...summarizeError(err) },
    },
  );
  if (sqlJsRuntimeStopReason !== undefined) return fatal;
  sqlJsRuntimeStopReason = fatal.message;
  process.stderr.write(`[localapp] ${fatal.message} (${JSON.stringify(summarizeError(err))})\n`);
  if (sqlJsRuntimeStop) {
    sqlJsRuntimeStop(fatal.message);
    return fatal;
  }
  // The process is unusable from here on; leave the log line behind before it goes.
  setImmediate(() => process.exit(1));
  return fatal;
}

/** The failure later requests get once the runtime is terminal, instead of a doomed reopen. */
export function unusableSqlJsRuntimeError(): LocalAppRuntimeError {
  return new LocalAppRuntimeError(
    "The LocalApp SQLite runtime is unusable after a WebAssembly trap; the Server must restart",
    { status: 503, code: "db_runtime_restart_required", details: {} },
  );
}

export function assertSqlJsRuntimeUsable(): void {
  if (sqlJsRuntimeStopReason !== undefined) throw unusableSqlJsRuntimeError();
}

/** Tests only: clears the terminal state so each case starts from a healthy runtime. */
export function resetSqlJsRuntimeUsability(): void {
  sqlJsRuntimeStopReason = undefined;
}
