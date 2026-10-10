import type { AppApiRoute } from "./app-api-contract.cjs";
import {
  executeNamedSql,
  executeNamedSqlTransaction,
  type BackendContract,
  type NamedSqlExecutionContext,
  type NamedSqlExecutionResult,
} from "./backend-contract.cjs";
import { LocalAppRuntimeError } from "./runtime-errors.cjs";

export type AppNamedSqlRoute = Extract<
  AppApiRoute,
  | { kind: "named-query" }
  | { kind: "named-mutation" }
  | { kind: "named-mutation-transaction" }
>;

export interface AppRuntimeErrorResponse {
  status: number;
  body: {
    success: false;
    error: string;
    code?: string;
  };
}

export interface AppNamedSqlRuntime {
  execute(
    route: AppNamedSqlRoute,
    body: unknown,
  ): Promise<NamedSqlExecutionResult | NamedSqlExecutionResult[]>;
  classifyError(error: unknown): AppRuntimeErrorResponse;
}

export function createAppNamedSqlRuntime(options: {
  contract: BackendContract;
  dbPath: string;
  context: () => NamedSqlExecutionContext;
}): AppNamedSqlRuntime {
  return {
    execute(route, body) {
      const context = options.context();
      return route.kind === "named-mutation-transaction"
        ? executeNamedSqlTransaction(options.contract, {
            dbPath: options.dbPath,
            body,
            context,
          })
        : executeNamedSql(options.contract, {
            kind: route.kind === "named-query" ? "query" : "mutation",
            name: route.name,
            dbPath: options.dbPath,
            body,
            context,
          });
    },
    classifyError(error) {
      return classifyAppRuntimeError(error, options.context().visitorId !== null);
    },
  };
}

export function classifyAppRuntimeError(
  error: unknown,
  authenticated: boolean,
): AppRuntimeErrorResponse {
  const message =
    error instanceof Error ? error.message : "Named SQL execution failed";
  if (error instanceof LocalAppRuntimeError) {
    return {
      status: error.status,
      body: {
        success: false,
        error: message,
        code: error.code,
      },
    };
  }
  if (/not found|backend root does not exist/i.test(message)) {
    return { status: 404, body: { success: false, error: message } };
  }
  if (/access denied/i.test(message)) {
    return {
      status: authenticated ? 403 : 401,
      body: {
        success: false,
        error: authenticated ? message : "Authentication required",
      },
    };
  }
  return { status: 400, body: { success: false, error: message } };
}
