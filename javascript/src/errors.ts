export class AuditError extends Error {
  override name = "AuditError";
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
  toJSON(): { code: string; message: string } {
    return { code: this.code, message: this.message };
  }
}
export function aborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new AuditError(
      signal.reason?.name === "TimeoutError" ? "TIMEOUT" : "CANCELLED",
      "The operation was interrupted.",
    );
}
export function positive(
  value: number,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isFinite(value) || value <= 0 || value > max)
    throw new AuditError(
      "CONFIG_INVALID",
      `${name} must be positive and at most ${max}.`,
    );
  return value;
}
export function integer(
  value: number,
  name: string,
  min: number,
  max: number,
): number {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new AuditError(
      "CONFIG_INVALID",
      `${name} must be an integer from ${min} to ${max}.`,
    );
  return value;
}
export function errorInfo(error: unknown): { code: string; message: string } {
  return error instanceof AuditError
    ? error.toJSON()
    : { code: "PROCESSING_FAILED", message: "The operation could not finish." };
}
/** Observers do not participate in processing or resource ownership. */
export function observe(callback: () => unknown): void {
  try {
    const returned = callback();
    if (
      returned &&
      typeof (returned as PromiseLike<unknown>).then === "function"
    )
      void Promise.resolve(returned).catch(() => {});
  } catch {}
}
