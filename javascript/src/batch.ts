import { availableParallelism } from "node:os";
import { basename } from "node:path";
import { analyze } from "./analysis.js";
import { limits } from "./input.js";
import { aborted, integer, AuditError, errorInfo } from "./errors.js";
import type { Batch, BatchOptions, BatchItem } from "./types.js";
export async function batch(
  files: string[],
  options: BatchOptions = {},
): Promise<Batch> {
  limits(options);
  const concurrency = integer(
    options.concurrency ?? Math.min(8, availableParallelism()),
    "concurrency",
    1,
    256,
  );
  const capacity = integer(options.maxQueued ?? 10000, "maxQueued", 1, 100000);
  if (!Array.isArray(files) || files.some((f) => typeof f !== "string"))
    throw new AuditError(
      "CONFIG_INVALID",
      "files must be an array of local paths.",
    );
  if (files.length > capacity)
    throw new AuditError("QUEUE_LIMIT", "The batch exceeds maxQueued.");
  aborted(options.signal);
  const controller = new AbortController();
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 3_600_000);
  const signal = AbortSignal.any([
    controller.signal,
    ...(options.signal ? [options.signal] : []),
    deadline,
  ]);
  const results: BatchItem[] = new Array(files.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < files.length) {
      const i = cursor++;
      const file = files[i];
      if (signal.aborted) {
        results[i] = {
          file: basename(file),
          state: "cancelled",
          error: {
            code: "CANCELLED",
            message: "The queued job was cancelled.",
          },
        };
        continue;
      }
      try {
        const analysis = await analyze(file, { ...options, signal });
        results[i] = { file: basename(file), state: "completed", analysis };
      } catch (e) {
        const error = errorInfo(e);
        results[i] = {
          file: basename(file),
          state: error.code === "CANCELLED" ? "cancelled" : "failed",
          error,
        };
        if (options.failFast) controller.abort();
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, worker),
  );
  aborted(options.signal);
  aborted(deadline);
  return { schemaVersion: 1, kind: "batch", concurrency, results };
}
