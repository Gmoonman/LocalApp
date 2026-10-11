export class LocalAppLifecycleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LocalAppLifecycleError";
  }
}

export function lifecycleError(
  code: string,
  message: string,
): LocalAppLifecycleError {
  return new LocalAppLifecycleError(code, message);
}
