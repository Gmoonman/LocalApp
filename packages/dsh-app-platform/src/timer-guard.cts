import { isWasmRuntimeError, markSqlJsRuntimeUnusable } from "./runtime-errors.cjs";

/**
 * Timer callbacks that touch SQLite run with no request around them, so a
 * WebAssembly trap there has no error boundary. Unguarded it either becomes an
 * uncaught exception that kills the process on the spot, or — when the callback
 * swallows its own errors — leaves the Server answering every database request
 * with a failure while nobody notices. Both happened in production: a 5s log
 * flush swallowed the first trap, and the 6h cleanup callback later crashed the
 * process with the same trap.
 *
 * A trap is terminal, so the guard routes it to the shared stop, and every other
 * failure is reported instead of vanishing.
 */
export function guardTimerCallback(label: string, callback: () => unknown): () => void {
  return () => {
    try {
      const result: unknown = callback();
      if (isPromiseLike(result)) {
        void result.catch((error: unknown) => reportTimerFailure(label, error));
      }
    } catch (error) {
      reportTimerFailure(label, error);
    }
  };
}

function reportTimerFailure(label: string, error: unknown): void {
  if (isWasmRuntimeError(error)) {
    markSqlJsRuntimeUnusable(error, label);
    return;
  }
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  process.stderr.write(`[localapp] ${label} failed: ${message}\n`);
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}
