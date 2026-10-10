import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { checkAccess } from "./access-control.cjs";
import { LocalAppRuntimeError, summarizeError } from "./runtime-errors.cjs";
import { isBoundedNamedQuery } from "./backend-contract.cjs";
import type { BackendContract, BackendManifestConfig, NamedSqlExecutionResult } from "./backend-contract.cjs";

export type ActionAccessLevel = "public" | "authenticated" | "owner" | "acl";
export type ActionType = "command";

export interface ActionInputSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, ActionInputSchema>;
  enum?: unknown[];
  nullable?: boolean;
  items?: ActionInputSchema;
}

export interface ActionManifestEntry {
  name: string;
  exportName: string;
  type?: ActionType;
  access?: ActionAccessLevel;
  acl?: string[];
  input?: ActionInputSchema;
  uses?: {
    queries?: string[];
    mutations?: string[];
  };
}

export interface ActionManifest {
  version: 1;
  bundle: string;
  actions: ActionManifestEntry[];
}

export interface ActionUser {
  id: string;
  name?: string | null;
  role?: string | null;
}

export interface ActionNotify {
  send(to: string | string[], payload: Record<string, unknown>): Promise<unknown> | unknown;
}

export interface ActionLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface ActionContext {
  user: ActionUser;
  ownerId: string;
  now: Date;
  query<T = NamedSqlExecutionResult>(name: string, params?: Record<string, unknown>): Promise<T>;
  mutate<T = NamedSqlExecutionResult>(name: string, params?: Record<string, unknown>): Promise<T>;
  transaction<T>(fn: () => Promise<T> | T): Promise<T>;
  consumeQueueWait(): number;
  notify: ActionNotify;
  log: ActionLogger;
}

export interface CreateActionContextOptions {
  user: ActionUser;
  ownerId: string;
  now: Date;
  query: (name: string, params?: Record<string, unknown>) => Promise<unknown> | unknown;
  mutate: (name: string, params?: Record<string, unknown>) => Promise<unknown> | unknown;
  transaction?: <T>(fn: () => Promise<T> | T) => Promise<T>;
  runtime?: {
    consumeQueueWait?: () => number;
    allowedQueries?: ReadonlySet<string>;
    allowedMutations?: ReadonlySet<string>;
  };
  notify?: Partial<ActionNotify>;
  log?: Partial<ActionLogger>;
}

export interface ExecuteHostedActionOptions {
  bundlePath: string;
  action: ActionManifestEntry;
  input: unknown;
  ctx: ActionContext;
  timeoutMs?: number;
  appKey?: string;
  actionQueueWaitMs?: number;
  runtimeBudget?: Partial<ActionRuntimeBudget>;
  actionConcurrency?: {
    max?: number;
    globalMax?: number;
    queueTimeoutMs?: number;
  };
  onDiagnostic?: (event: ActionRuntimeDiagnosticEvent) => void;
}

export interface ActionRuntimeBudget {
  maxRpcCount: number;
  maxSqlRowsPerCall: number;
  maxTotalSqlRows: number;
  maxSqlBytesPerCall: number;
  maxTotalSqlBytes: number;
  maxResultBytes: number;
}

export type ActionRuntimeDiagnosticEvent =
  | {
    type: "action:start";
    actionName: string;
    appKey?: string;
  }
  | {
    type: "action:finish";
    actionName: string;
    appKey?: string;
    ok: boolean;
    durationMs: number;
    rpcCount: number;
    sqlCount: number;
    sqlRows: number;
    sqlBytes: number;
    resultBytes: number;
    actionQueueWaitMs: number;
    dbQueueWaitMs: number;
    errorCode?: string;
    workerExitCode?: number;
  }
  | {
    type: "action:rpc";
    actionName: string;
    appKey?: string;
    method: string;
    sqlName?: string;
    durationMs: number;
    rows?: number;
    bytes?: number;
    queueWaitMs?: number;
    errorCode?: string;
  }
  | {
    type: "action:schedule_reject";
    actionName: string;
    appKey?: string;
    errorCode: string;
    details?: Record<string, unknown>;
  };

export class ActionError extends Error {
  status: number;
  code?: string;
  details?: Record<string, unknown>;
  override cause?: unknown;

  constructor(
    message: string,
    status = 400,
    options: {
      code?: string;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "ActionError";
    this.status = status;
    this.code = options.code;
    this.details = options.details;
    this.cause = options.cause;
  }
}

export function discoverActionSources(projectDir: string, config: BackendManifestConfig | undefined): string[] {
  const root = config?.root ?? "backend";
  const include = config?.include ?? [];
  const candidates = include.length > 0
    ? walkFiles(projectDir).filter((filePath) => include.some((pattern) => globMatches(normalizePath(pattern), normalizePath(path.relative(projectDir, filePath)))))
    : walkFiles(path.resolve(projectDir, root));

  return candidates
    .map((filePath) => normalizePath(path.relative(projectDir, filePath)))
    .filter((relativePath) => /(^|\/)actions\/.+\.(?:ts|tsx|js|mjs)$/.test(relativePath))
    .sort();
}

export function loadActionManifest(projectDir: string, config: BackendManifestConfig | undefined): ActionManifest | null {
  const root = config?.root ?? "backend";
  const include = config?.include ?? [];
  const manifestPath = include.length > 0
    ? walkFiles(projectDir)
      .map((filePath) => normalizePath(path.relative(projectDir, filePath)))
      .find((relativePath) => include.some((pattern) => globMatches(normalizePath(pattern), relativePath)) && relativePath.endsWith("actions.manifest.json"))
    : normalizePath(path.join(root, "actions.manifest.json"));

  if (!manifestPath) return null;
  const absolutePath = path.resolve(projectDir, manifestPath);
  if (!fs.existsSync(absolutePath)) return null;
  const value = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  return parseActionManifest(value);
}

export function parseActionManifest(value: unknown): ActionManifest {
  if (!isRecord(value)) throw new Error("Action manifest must be an object");
  if (value.version !== 1) throw new Error("Action manifest version must be 1");
  if (typeof value.bundle !== "string" || !value.bundle.trim()) {
    throw new Error("Action manifest must declare bundle");
  }
  if (!Array.isArray(value.actions)) throw new Error("Action manifest actions must be an array");
  return {
    version: 1,
    bundle: value.bundle,
    actions: value.actions.map((entry, index) => parseActionEntry(entry, index)),
  };
}

export function validateActionManifest(manifest: ActionManifest, contract: BackendContract): void {
  const names = new Set<string>();
  for (const action of manifest.actions) {
    if (names.has(action.name)) throw new Error(`Duplicate action name: ${action.name}`);
    names.add(action.name);
    validateActionEntry(action, contract);
  }
}

export function validateActionEntry(action: ActionManifestEntry, contract: BackendContract): void {
  if (!isAccessLevel(action.access ?? "authenticated")) {
    throw new Error(`Invalid action access for ${action.name}: ${String(action.access)}`);
  }
  if (action.type !== undefined && action.type !== "command") {
    throw new Error(`Invalid action type for ${action.name}: ${String(action.type)}`);
  }
  if (!action.uses || (!action.uses.queries && !action.uses.mutations)) {
    throw new Error(`Action ${action.name} must declare uses allowlist`);
  }
  validateInputSchema(action.name, action.input ?? { type: "object" });
  for (const query of action.uses?.queries ?? []) {
    if (!contract.queries[query]) throw new Error(`Action ${action.name} references unknown query: ${query}`);
    if (!isBoundedNamedQuery(query, contract.queries[query])) {
      throw new Error(`Action ${action.name} query ${query} must declare bounded result metadata with pagination, single-row or aggregate bounds`);
    }
  }
  for (const mutation of action.uses?.mutations ?? []) {
    if (!contract.mutations[mutation]) throw new Error(`Action ${action.name} references unknown mutation: ${mutation}`);
  }
}

export function findAction(manifest: ActionManifest, name: string): ActionManifestEntry | null {
  return manifest.actions.find((action) => action.name === name) ?? null;
}

export function assertActionAccess(action: ActionManifestEntry, visitorId: string | null | undefined, ownerId: string): void {
  const level = action.access ?? "authenticated";
  if (checkAccess(level, visitorId, ownerId, action.acl)) return;
  if (!visitorId) throw new ActionError("Authentication required", 401);
  throw new ActionError("Access denied", 403);
}

export function validateActionInput(action: ActionManifestEntry, input: unknown): Record<string, unknown> {
  const schema = action.input ?? { type: "object" };
  validateValue(`${action.name}.input`, schema, input);
  return isRecord(input) ? input : {};
}

export function createActionContext(options: CreateActionContextOptions): ActionContext {
  return {
    user: { ...options.user },
    ownerId: options.ownerId,
    now: new Date(options.now),
    query: async <T = NamedSqlExecutionResult,>(name: string, params?: Record<string, unknown>) => {
      assertAllowedSql("query", name, options.runtime?.allowedQueries);
      return options.query(name, params) as Promise<T>;
    },
    mutate: async <T = NamedSqlExecutionResult,>(name: string, params?: Record<string, unknown>) => {
      assertAllowedSql("mutation", name, options.runtime?.allowedMutations);
      return options.mutate(name, params) as Promise<T>;
    },
    consumeQueueWait: () => options.runtime?.consumeQueueWait?.() ?? 0,
    transaction: async (fn) => {
      if (!options.transaction) {
        throw new ActionError("Action transaction is not available", 500);
      }
      return options.transaction(fn);
    },
    notify: {
      send: async (to, payload) => options.notify?.send?.(to, payload) ?? { delivered: 0 },
    },
    log: {
      info: (message, meta) => options.log?.info?.(message, meta),
      error: (message, meta) => options.log?.error?.(message, meta),
    },
  };
}

function assertAllowedSql(kind: "query" | "mutation", name: string, allowed: ReadonlySet<string> | undefined): void {
  if (!allowed) return;
  if (allowed?.has(name)) return;
  throw new ActionError(`Action is not allowed to call undeclared ${kind}: ${name}`, 400, {
    code: "action_contract_violation",
    details: { kind, name },
  });
}

export async function executeHostedAction(options: ExecuteHostedActionOptions): Promise<unknown> {
  const input = validateActionInput(options.action, options.input);
  validateActionBundleBoundary(options.bundlePath);
  const queuedAt = Date.now();
  const run = () => executeHostedActionInWorker({
    ...options,
    input,
    actionQueueWaitMs: options.appKey ? Date.now() - queuedAt : 0,
  }, options.timeoutMs ?? 10_000);
  if (!options.appKey) return run();
  try {
    return await withActionConcurrency(options.appKey, options.actionConcurrency, run);
  } catch (err) {
    if (err instanceof ActionError && err.code === "action_queue_timeout") {
      emitDiagnostic(options, {
        type: "action:schedule_reject",
        actionName: options.action.name,
        appKey: options.appKey,
        errorCode: err.code,
        details: err.details,
      });
    }
    throw err;
  }
}

interface ActionQueueWaiter {
  resolve: () => void;
  reject: (err: unknown) => void;
  timer: NodeJS.Timeout | null;
}

interface ActionQueueState {
  active: number;
  waiters: ActionQueueWaiter[];
}

const DEFAULT_ACTION_CONCURRENCY_MAX = 2;
const DEFAULT_GLOBAL_ACTION_CONCURRENCY_MAX = 8;
const DEFAULT_ACTION_QUEUE_TIMEOUT_MS = 1_000;
const DEFAULT_ACTION_RUNTIME_BUDGET: ActionRuntimeBudget = {
  maxRpcCount: 100,
  maxSqlRowsPerCall: 1_000,
  maxTotalSqlRows: 5_000,
  maxSqlBytesPerCall: 1024 * 1024,
  maxTotalSqlBytes: 5 * 1024 * 1024,
  maxResultBytes: 1024 * 1024,
};
const actionQueues = new Map<string, ActionQueueState>();
const globalActionQueue: ActionQueueState = { active: 0, waiters: [] };

async function withActionConcurrency<T>(
  appKey: string,
  options: ExecuteHostedActionOptions["actionConcurrency"] | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const releaseApp = await acquireActionSlot(appKey, options);
  let releaseGlobal: (() => void) | null = null;
  try {
    releaseGlobal = await acquireGlobalActionSlot(options);
    return await fn();
  } catch (err) {
    if (!releaseGlobal) releaseApp();
    throw err;
  } finally {
    if (releaseGlobal) {
      releaseGlobal();
      releaseApp();
    }
  }
}

function acquireActionSlot(
  appKey: string,
  options: ExecuteHostedActionOptions["actionConcurrency"] | undefined,
): Promise<() => void> {
  const max = Math.max(1, options?.max ?? DEFAULT_ACTION_CONCURRENCY_MAX);
  const state = actionQueues.get(appKey) ?? { active: 0, waiters: [] };
  actionQueues.set(appKey, state);
  if (state.active < max) {
    state.active += 1;
    return Promise.resolve(createActionRelease(appKey, state));
  }
  const timeoutMs = options?.queueTimeoutMs ?? DEFAULT_ACTION_QUEUE_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const waiter: ActionQueueWaiter = {
      resolve: () => resolve(createActionRelease(appKey, state)),
      reject,
      timer: null,
    };
    waiter.timer = setTimeout(() => {
      const index = state.waiters.indexOf(waiter);
      if (index >= 0) state.waiters.splice(index, 1);
      reject(new ActionError("Hosted action concurrency queue timed out", 429, {
        code: "action_queue_timeout",
        details: { appKey, max, queueTimeoutMs: timeoutMs },
      }));
    }, timeoutMs);
    state.waiters.push(waiter);
  });
}

function acquireGlobalActionSlot(
  options: ExecuteHostedActionOptions["actionConcurrency"] | undefined,
): Promise<() => void> {
  const max = Math.max(1, options?.globalMax ?? DEFAULT_GLOBAL_ACTION_CONCURRENCY_MAX);
  if (globalActionQueue.active < max) {
    globalActionQueue.active += 1;
    return Promise.resolve(createGlobalActionRelease(globalActionQueue));
  }
  const timeoutMs = options?.queueTimeoutMs ?? DEFAULT_ACTION_QUEUE_TIMEOUT_MS;
  const enqueuedAt = Date.now();
  return new Promise((resolve, reject) => {
    const waiter: ActionQueueWaiter = {
      resolve: () => resolve(createGlobalActionRelease(globalActionQueue)),
      reject,
      timer: null,
    };
    waiter.timer = setTimeout(() => {
      const index = globalActionQueue.waiters.indexOf(waiter);
      if (index >= 0) globalActionQueue.waiters.splice(index, 1);
      reject(new ActionError("Hosted action runtime queue timed out", 429, {
        code: "action_queue_timeout",
        details: {
          activeWorkers: globalActionQueue.active,
          maxWorkers: max,
          queueTimeoutMs: timeoutMs,
          waitMs: Date.now() - enqueuedAt,
        },
      }));
    }, timeoutMs);
    globalActionQueue.waiters.push(waiter);
  });
}

function createGlobalActionRelease(state: ActionQueueState): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = state.waiters.shift();
    if (next) {
      if (next.timer) clearTimeout(next.timer);
      next.resolve();
      return;
    }
    state.active = Math.max(0, state.active - 1);
  };
}

function createActionRelease(appKey: string, state: ActionQueueState): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = state.waiters.shift();
    if (next) {
      if (next.timer) clearTimeout(next.timer);
      next.resolve();
      return;
    }
    state.active = Math.max(0, state.active - 1);
    if (state.active === 0 && state.waiters.length === 0 && actionQueues.get(appKey) === state) {
      actionQueues.delete(appKey);
    }
  };
}

function validateActionBundleBoundary(bundlePath: string): void {
  const source = fs.readFileSync(bundlePath, "utf8");
  const forbidden = [
    /\bfrom\s+["'](?:node:)?(?:fs|http|https|net|tls|child_process|cluster|worker_threads|dgram|sqlite3|better-sqlite3|sql\.js)["']/,
    /\bimport\s*\(\s*["'](?:node:)?(?:fs|http|https|net|tls|child_process|cluster|worker_threads|dgram|sqlite3|better-sqlite3|sql\.js)["']\s*\)/,
    /\bcreateServer\s*\(/,
    /\.listen\s*\(/,
    /\bfetch\s*\(/,
  ];
  if (forbidden.some((pattern) => pattern.test(source))) {
    throw new ActionError("Action bundle uses capabilities outside the hosted ctx boundary", 400);
  }
}

function executeHostedActionInWorker(options: ExecuteHostedActionOptions, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const budget = { ...DEFAULT_ACTION_RUNTIME_BUDGET, ...options.runtimeBudget };
    const summary = {
      rpcCount: 0,
      sqlCount: 0,
      sqlRows: 0,
      sqlBytes: 0,
      resultBytes: 0,
      actionQueueWaitMs: options.actionQueueWaitMs ?? 0,
      dbQueueWaitMs: 0,
    };
    emitDiagnostic(options, {
      type: "action:start",
      actionName: options.action.name,
      appKey: options.appKey,
    });
    const worker = new Worker(ACTION_WORKER_SOURCE, {
      eval: true,
      execArgv: ["--experimental-vm-modules"],
      workerData: {
        bundleSource: fs.readFileSync(options.bundlePath, "utf8"),
        exportName: options.action.exportName,
        input: options.input,
        user: options.ctx.user,
        ownerId: options.ctx.ownerId,
        now: options.ctx.now.toISOString(),
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
      },
    });
    const transactions = new Map<number, {
      ready: Promise<void>;
      resolveReady: () => void;
      resolve: (value: unknown) => void;
      reject: (err: unknown) => void;
      done: Promise<unknown>;
    }>();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      const err = new ActionError("Action execution timed out", 504, { code: "action_timeout" });
      emitFinishDiagnostic(options, startedAt, summary, false, err.code);
      reject(err);
    }, timeoutMs);

    function finish(fn: () => void, ok: boolean, errorCode?: string, workerExitCode?: number) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      emitFinishDiagnostic(options, startedAt, summary, ok, errorCode, workerExitCode);
      fn();
    }

    worker.on("message", (message) => {
      void handleWorkerMessage(message);
    });
    worker.on("error", (err) => {
      const wrapped = wrapActionWorkerError(err);
      finish(() => reject(wrapped), false, wrapped.code);
    });
    worker.on("exit", (code) => {
      if (!settled && code !== 0) {
        const err = new ActionError("Action worker exited before completing hosted action", 500, {
          code: "action_resource_limit",
          details: { exitCode: code },
        });
        finish(() => reject(err), false, err.code, code);
      }
    });

    async function handleWorkerMessage(message: any) {
      if (!message || typeof message !== "object") return;
      if (message.type === "done") {
        if (message.ok) {
          const resultBytes = estimateJsonBytes(message.value);
          summary.resultBytes = resultBytes;
          const budgetError = checkActionResultBudget(resultBytes, budget);
          if (budgetError) {
            finish(() => reject(budgetError), false, budgetError.code);
            return;
          }
          finish(() => resolve(message.value), true);
        }
        else {
          const err = deserializeActionError(message.error);
          finish(() => reject(err), false, err instanceof ActionError ? err.code : undefined);
        }
        return;
      }
      if (message.type !== "rpc") return;
      const rpcStartedAt = Date.now();
      const sqlName = typeof message.args?.[0] === "string" ? message.args[0] : undefined;
      try {
        checkRpcBudget(summary, budget);
        const value = await handleRpc(message.method, message.args ?? []);
        checkSqlBudget(message.method, value, summary, budget);
        recordRpcDiagnostic(options, summary, message.method, sqlName, rpcStartedAt, value, undefined, options.ctx.consumeQueueWait());
        postWorkerMessage({ type: "rpcResult", id: message.id, ok: true, value });
      } catch (err) {
        recordRpcDiagnostic(options, summary, message.method, sqlName, rpcStartedAt, undefined, errorCodeOf(err), options.ctx.consumeQueueWait());
        postWorkerMessage({ type: "rpcResult", id: message.id, ok: false, error: serializeActionError(err) });
      }
    }

    function postWorkerMessage(message: unknown) {
      try {
        worker.postMessage(message);
      } catch (err) {
        const wrapped = wrapActionWorkerError(err, "Action worker failed to serialize RPC result");
        finish(() => reject(wrapped), false, wrapped.code);
      }
    }

    async function handleRpc(method: string, args: unknown[]) {
      switch (method) {
        case "query":
          return options.ctx.query(String(args[0]), asParams(args[1]));
        case "mutate":
          return options.ctx.mutate(String(args[0]), asParams(args[1]));
        case "notify.send":
          return options.ctx.notify.send(args[0] as string | string[], asParams(args[1]) ?? {});
        case "log.info":
          options.ctx.log.info(String(args[0]), asParams(args[1]));
          return null;
        case "log.error":
          options.ctx.log.error(String(args[0]), asParams(args[1]));
          return null;
        case "transaction.begin":
          return beginWorkerTransaction();
        case "transaction.commit":
          return finishWorkerTransaction(Number(args[0]), true);
        case "transaction.rollback":
          return finishWorkerTransaction(Number(args[0]), false, args[1]);
        default:
          throw new ActionError(`Unsupported action ctx method: ${method}`, 500);
      }
    }

    async function beginWorkerTransaction() {
      const txId = transactions.size + 1;
      let resolveReady!: () => void;
      const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
      const tx: {
        ready: Promise<void>;
        resolveReady: () => void;
        resolve: (value: unknown) => void;
        reject: (err: unknown) => void;
        done: Promise<unknown>;
      } = {
        ready,
        resolveReady,
        resolve: (_value: unknown) => {},
        reject: (_err: unknown) => {},
        done: Promise.resolve(null) as Promise<unknown>,
      };
      const done = options.ctx.transaction(async () => {
        resolveReady();
        return new Promise((resolve, reject) => {
          tx.resolve = resolve;
          tx.reject = reject;
        });
      });
      tx.done = done;
      transactions.set(txId, tx);
      await ready;
      return txId;
    }

    async function finishWorkerTransaction(txId: number, commit: boolean, error?: unknown) {
      const tx = transactions.get(txId);
      if (!tx) throw new ActionError(`Unknown action transaction: ${txId}`, 500);
      transactions.delete(txId);
      if (commit) tx.resolve(null);
      else tx.reject(deserializeActionError(error));
      await tx.done.catch((err) => {
        if (commit) throw err;
      });
      return null;
    }
  });
}

function asParams(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function serializeActionError(err: unknown) {
  return {
    message: err instanceof Error ? err.message : String(err),
    status: err instanceof ActionError || err instanceof LocalAppRuntimeError ? err.status : undefined,
    code: err instanceof ActionError ? err.code : err instanceof LocalAppRuntimeError ? err.code : undefined,
    details: err instanceof ActionError || err instanceof LocalAppRuntimeError ? err.details : undefined,
    name: err instanceof Error ? err.name : undefined,
  };
}

function deserializeActionError(value: unknown): Error {
  if (isRecord(value)) {
    const message = typeof value.message === "string" ? value.message : "Action execution failed";
    const status = typeof value.status === "number" ? value.status : undefined;
    const name = typeof value.name === "string" ? value.name : "";
    const code = typeof value.code === "string" ? value.code : undefined;
    const details = isRecord(value.details) ? value.details : undefined;
    if (code === "action_resource_limit" || name === "DataCloneError" || /could not be cloned/i.test(message)) {
      return new ActionError("Action worker failed to serialize result", 500, {
        code: "action_resource_limit",
        details: { originalMessage: message },
      });
    }
    return new ActionError(message, status ?? 400, { code: code ?? "action_runtime_error", details });
  }
  return new ActionError(String(value ?? "Action execution failed"), 400, { code: "action_runtime_error" });
}

function wrapActionWorkerError(err: unknown, message = "Action worker runtime error"): ActionError {
  const text = err instanceof Error ? err.message : String(err ?? "");
  if (/could not be cloned|DataCloneError/i.test(text)) {
    return new ActionError("Action worker failed to serialize result", 500, {
      code: "action_resource_limit",
      details: summarizeError(err),
      cause: err,
    });
  }
  return new ActionError(message, 500, {
    code: "action_resource_limit",
    details: summarizeError(err),
    cause: err,
  });
}

function checkRpcBudget(
  summary: { rpcCount: number },
  budget: ActionRuntimeBudget,
): void {
  if (summary.rpcCount + 1 <= budget.maxRpcCount) return;
  throw new ActionError("Action RPC count exceeded platform budget", 413, {
    code: "action_rpc_limit_exceeded",
    details: {
      maxRpcCount: budget.maxRpcCount,
      rpcCount: summary.rpcCount + 1,
    },
  });
}

function checkSqlBudget(
  method: string,
  value: unknown,
  summary: { sqlRows: number; sqlBytes: number },
  budget: ActionRuntimeBudget,
): void {
  if (method !== "query" && method !== "mutate") return;
  const rows = countRows(value);
  const bytes = estimateJsonBytes(value);
  if (rows > budget.maxSqlRowsPerCall || summary.sqlRows + rows > budget.maxTotalSqlRows) {
    throw new ActionError("Action SQL result exceeded row budget. Use paginated named SQL, filtering, JOINs, or aggregation.", 413, {
      code: "action_sql_result_too_large",
      details: {
        rows,
        totalRows: summary.sqlRows + rows,
        maxSqlRowsPerCall: budget.maxSqlRowsPerCall,
        maxTotalSqlRows: budget.maxTotalSqlRows,
      },
    });
  }
  if (bytes > budget.maxSqlBytesPerCall || summary.sqlBytes + bytes > budget.maxTotalSqlBytes) {
    throw new ActionError("Action SQL result exceeded byte budget. Use paginated named SQL, filtering, JOINs, or aggregation.", 413, {
      code: "action_sql_result_too_large",
      details: {
        bytes,
        totalBytes: summary.sqlBytes + bytes,
        maxSqlBytesPerCall: budget.maxSqlBytesPerCall,
        maxTotalSqlBytes: budget.maxTotalSqlBytes,
      },
    });
  }
}

function checkActionResultBudget(resultBytes: number, budget: ActionRuntimeBudget): ActionError | null {
  if (resultBytes <= budget.maxResultBytes) return null;
  return new ActionError("Action result exceeded platform budget. Use paginated named SQL or aggregation.", 413, {
    code: "action_result_too_large",
    details: {
      resultBytes,
      maxResultBytes: budget.maxResultBytes,
    },
  });
}

function emitDiagnostic(options: ExecuteHostedActionOptions, event: ActionRuntimeDiagnosticEvent): void {
  options.onDiagnostic?.(event);
}

function emitFinishDiagnostic(
  options: ExecuteHostedActionOptions,
  startedAt: number,
  summary: { rpcCount: number; sqlCount: number; sqlRows: number; sqlBytes: number; resultBytes: number; actionQueueWaitMs: number; dbQueueWaitMs: number },
  ok: boolean,
  errorCode?: string,
  workerExitCode?: number,
): void {
  emitDiagnostic(options, {
    type: "action:finish",
    actionName: options.action.name,
    appKey: options.appKey,
    ok,
    durationMs: Date.now() - startedAt,
    rpcCount: summary.rpcCount,
    sqlCount: summary.sqlCount,
    sqlRows: summary.sqlRows,
    sqlBytes: summary.sqlBytes,
    resultBytes: summary.resultBytes,
    actionQueueWaitMs: summary.actionQueueWaitMs,
    dbQueueWaitMs: summary.dbQueueWaitMs,
    errorCode,
    workerExitCode,
  });
}

function recordRpcDiagnostic(
  options: ExecuteHostedActionOptions,
  summary: { rpcCount: number; sqlCount: number; sqlRows: number; sqlBytes: number; dbQueueWaitMs: number },
  method: string,
  sqlName: string | undefined,
  startedAt: number,
  value: unknown,
  errorCode?: string,
  queueWaitMs = 0,
): void {
  summary.rpcCount += 1;
  const isSql = method === "query" || method === "mutate";
  const rows = isSql ? countRows(value) : undefined;
  const bytes = isSql ? estimateJsonBytes(value) : undefined;
  summary.dbQueueWaitMs += queueWaitMs;
  if (isSql) {
    summary.sqlCount += 1;
    summary.sqlRows += rows ?? 0;
    summary.sqlBytes += bytes ?? 0;
  }
  emitDiagnostic(options, {
    type: "action:rpc",
    actionName: options.action.name,
    appKey: options.appKey,
    method,
    sqlName: method === "query" || method === "mutate" ? sqlName : undefined,
    durationMs: Date.now() - startedAt,
    rows,
    bytes,
    queueWaitMs,
    errorCode,
  });
}

function countRows(value: unknown): number {
  if (isRecord(value) && Array.isArray(value.rows)) return value.rows.length;
  return 0;
}

function estimateJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}

function errorCodeOf(err: unknown): string | undefined {
  if (err instanceof ActionError) return err.code;
  if (err instanceof LocalAppRuntimeError) return err.code;
  return undefined;
}

const ACTION_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");

globalThis.fetch = undefined;
globalThis.XMLHttpRequest = undefined;
globalThis.WebSocket = undefined;
globalThis.process = undefined;

let nextRpcId = 1;
const pending = new Map();

parentPort.on("message", (message) => {
  if (!message || message.type !== "rpcResult") return;
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id);
  if (message.ok) item.resolve(message.value);
  else item.reject(deserialize(message.error));
});

function rpc(method, args = []) {
  const id = nextRpcId++;
  parentPort.postMessage({ type: "rpc", id, method, args });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function serialize(err) {
  return {
    message: err && err.message ? err.message : String(err),
    status: err && err.status,
    code: err && err.code,
    details: err && err.details,
    name: err && err.name
  };
}

function deserialize(value) {
  const err = new Error(value && value.message ? value.message : "Action execution failed");
  if (value && value.status) err.status = value.status;
  if (value && value.code) err.code = value.code;
  if (value && value.details) err.details = value.details;
  return err;
}

function makeCtx() {
  return {
    user: workerData.user,
    ownerId: workerData.ownerId,
    now: new Date(workerData.now),
    query: (name, params) => rpc("query", [name, params]),
    mutate: (name, params) => rpc("mutate", [name, params]),
    async transaction(fn) {
      const txId = await rpc("transaction.begin");
      try {
        const result = await fn();
        await rpc("transaction.commit", [txId]);
        return result;
      } catch (err) {
        await rpc("transaction.rollback", [txId, serialize(err)]).catch(() => undefined);
        throw err;
      }
    },
    notify: { send: (to, payload) => rpc("notify.send", [to, payload]) },
    log: {
      info: (message, meta) => rpc("log.info", [message, meta]),
      error: (message, meta) => rpc("log.error", [message, meta]),
    },
  };
}

(async () => {
  try {
    if (typeof vm.SourceTextModule !== "function") {
      const err = new Error("Action VM modules are unavailable");
      err.status = 500;
      throw err;
    }
    const context = vm.createContext({
      console: Object.freeze({
        log() {},
        info() {},
        warn() {},
        error() {},
      }),
      setTimeout,
      clearTimeout,
      Date,
      Promise,
      Error,
      Array,
      Object,
      JSON,
      Math,
    });
    const rejectImport = async (specifier) => {
      const err = new Error("Action imports are not allowed: " + specifier);
      err.status = 400;
      throw err;
    };
    const module = new vm.SourceTextModule(workerData.bundleSource, {
      context,
      identifier: "localapp:action-bundle",
      initializeImportMeta(meta) {
        meta.url = "localapp:action-bundle";
      },
      importModuleDynamically: rejectImport,
    });
    await module.link(rejectImport);
    await module.evaluate();
    const exported = module.namespace[workerData.exportName];
    const handler = exported && exported.handler ? exported.handler : exported;
    if (typeof handler !== "function") {
      const err = new Error("Action handler not found: " + workerData.exportName);
      err.status = 500;
      throw err;
    }
    const value = await handler(makeCtx(), workerData.input);
    parentPort.postMessage({ type: "done", ok: true, value });
  } catch (err) {
    parentPort.postMessage({ type: "done", ok: false, error: serialize(err) });
  }
})();
`;

function parseActionEntry(value: unknown, index: number): ActionManifestEntry {
  if (!isRecord(value)) throw new Error(`Action entry at index ${index} must be an object`);
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error(`Action entry at index ${index} must declare name`);
  if (typeof value.exportName !== "string" || !value.exportName.trim()) throw new Error(`Action ${value.name} must declare exportName`);
  const entry: ActionManifestEntry = {
    name: value.name,
    exportName: value.exportName,
    type: value.type === undefined || value.type === "command" ? value.type : value.type as never,
    access: isAccessLevel(value.access) ? value.access : value.access === undefined ? undefined : value.access as never,
    input: value.input === undefined ? { type: "object" } : value.input as ActionInputSchema,
    uses: isRecord(value.uses) ? {
      queries: parseStringArray(value.uses.queries, `Action ${value.name} uses.queries`),
      mutations: parseStringArray(value.uses.mutations, `Action ${value.name} uses.mutations`),
    } : undefined,
  };
  if (value.acl !== undefined) {
    if (!Array.isArray(value.acl) || value.acl.some((item) => typeof item !== "string")) {
      throw new Error(`Action ${value.name} acl must be an array of strings`);
    }
    entry.acl = value.acl;
  }
  return entry;
}

function validateInputSchema(actionName: string, schema: ActionInputSchema): void {
  validateSchemaNode(`${actionName}.input`, schema);
}

function validateSchemaNode(label: string, schema: ActionInputSchema): void {
  const allowed = new Set(["object", "string", "number", "boolean", "array", "unknown"]);
  if (schema.type !== undefined && !allowed.has(schema.type)) {
    throw new Error(`Invalid action input schema at ${label}: unsupported type ${schema.type}`);
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== "string"))) {
    throw new Error(`Invalid action input schema at ${label}: required must be string[]`);
  }
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) throw new Error(`Invalid action input schema at ${label}: properties must be an object`);
    for (const [key, child] of Object.entries(schema.properties)) validateSchemaNode(`${label}.${key}`, child);
  }
  if (schema.items !== undefined) validateSchemaNode(`${label}[]`, schema.items);
}

function validateValue(label: string, schema: ActionInputSchema, value: unknown): void {
  if (value === null) {
    if (schema.nullable) return;
    throw new ActionError(`${label} must not be null`, 400);
  }
  if (schema.enum && !schema.enum.includes(value)) throw new ActionError(`${label} has invalid value`, 400);
  switch (schema.type ?? "object") {
    case "unknown":
      return;
    case "object": {
      if (!isRecord(value)) throw new ActionError(`${label} must be an object`, 400);
      const required = schema.required ?? [];
      for (const key of required) {
        if (value[key] === undefined) throw new ActionError(`${label}.${key} is required`, 400);
      }
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (value[key] !== undefined) validateValue(`${label}.${key}`, child, value[key]);
      }
      return;
    }
    case "string":
      if (typeof value !== "string") throw new ActionError(`${label} must be a string`, 400);
      return;
    case "number":
      if (typeof value !== "number") throw new ActionError(`${label} must be a number`, 400);
      return;
    case "boolean":
      if (typeof value !== "boolean") throw new ActionError(`${label} must be a boolean`, 400);
      return;
    case "array":
      if (!Array.isArray(value)) throw new ActionError(`${label} must be an array`, 400);
      for (const [index, item] of value.entries()) validateValue(`${label}[${index}]`, schema.items ?? { type: "unknown" }, item);
      return;
    default:
      throw new ActionError(`${label} uses unsupported schema type`, 400);
  }
}

function isAccessLevel(value: unknown): value is ActionAccessLevel {
  return value === "public" || value === "authenticated" || value === "owner" || value === "acl";
}

function parseStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(entryPath));
    else if (entry.isFile()) result.push(entryPath);
  }
  return result;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function globMatches(pattern: string, candidate: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`).test(candidate);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
