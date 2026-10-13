import { availableParallelism, freemem } from "node:os";
import { resolve, basename, dirname, join } from "node:path";
import { realpath } from "node:fs/promises";
import { Auditor } from "./pool.js";
import type { PoolOptions } from "./pool.js";
import { processAudio, processingLimits } from "./processing.js";
import type {
  ProcessingOptions,
  ProcessingMode,
  ProcessingResult,
} from "./processing.js";
import { AuditError, aborted, integer, errorInfo } from "./errors.js";

export interface AudioClientOptions extends PoolOptions, ProcessingOptions {
  totalMemoryBudgetMiB?: number;
}
/** Shared scheduling for processing and audit methods; close physically fences active work. */
export class AudioClient extends Auditor {
  readonly totalMemoryBudgetMiB: number;
  readonly jobMemoryBudgetMiB: number;
  constructor(private readonly processingSettings: AudioClientOptions = {}) {
    processingLimits(processingSettings);
    const jobBudget = processingSettings.memoryBudgetMiB ?? 512;
    const available =
      typeof process.availableMemory === "function"
        ? Math.min(freemem(), process.availableMemory())
        : freemem();
    const totalBudget = integer(
      processingSettings.totalMemoryBudgetMiB ??
        Math.max(jobBudget, Math.floor(available / 1048576 / 2)),
      "totalMemoryBudgetMiB",
      32,
      1_048_576,
    );
    const concurrency =
      processingSettings.concurrency ??
      Math.max(
        1,
        Math.min(
          8,
          availableParallelism(),
          Math.floor(totalBudget / jobBudget),
        ),
      );
    if (concurrency * jobBudget > totalBudget)
      throw new AuditError(
        "CONFIG_INVALID",
        "concurrency × memoryBudgetMiB exceeds totalMemoryBudgetMiB.",
      );
    super({
      ...processingSettings,
      memoryBudgetMiB: jobBudget,
      concurrency,
    } as AudioClientOptions);
    this.totalMemoryBudgetMiB = totalBudget;
    this.jobMemoryBudgetMiB = jobBudget;
  }
  process(
    file: string,
    output: string,
    mode: ProcessingMode,
    options: ProcessingOptions = {},
  ): Promise<ProcessingResult> {
    try {
      processingLimits({ ...this.processingSettings, ...options });
      if (
        options.memoryBudgetMiB !== undefined &&
        options.memoryBudgetMiB > this.jobMemoryBudgetMiB
      )
        throw new AuditError(
          "CONFIG_INVALID",
          "Per-job memoryBudgetMiB exceeds this client's admission reservation.",
        );
    } catch (e) {
      return Promise.reject(e);
    }
    return this.schedule(
      (shared) =>
        processAudio(file, output, mode, {
          ...this.processingSettings,
          ...options,
          ...shared,
        }),
      options,
    );
  }
  denoise(file: string, output: string, options: ProcessingOptions = {}) {
    return this.process(file, output, "denoise", options);
  }
  enhance(file: string, output: string, options: ProcessingOptions = {}) {
    return this.process(file, output, "enhance", options);
  }
  normalize(file: string, output: string, options: ProcessingOptions = {}) {
    return this.process(file, output, "normalize", options);
  }
  convert(file: string, output: string, options: ProcessingOptions = {}) {
    return this.process(file, output, "convert", options);
  }
}
export const createAudioClient = (options: AudioClientOptions = {}) =>
  new AudioClient(options);
export interface ProcessingJob {
  input: string;
  output: string;
  mode?: ProcessingMode;
  options?: ProcessingOptions;
}
export type ProcessingOutcome =
  | {
      index: number;
      file: string;
      state: "completed";
      result: ProcessingResult;
    }
  | {
      index: number;
      file: string;
      state: "failed" | "cancelled";
      error: { code: string; message: string };
    };
export interface ProcessingBatchOptions extends AudioClientOptions {
  failFast?: boolean;
}
export interface ProcessingBatchResult {
  schemaVersion: 1;
  kind: "processing-batch";
  results: ProcessingOutcome[];
}
export async function processBatch(
  jobs: ProcessingJob[],
  options: ProcessingBatchOptions = {},
): Promise<ProcessingBatchResult> {
  processingLimits(options);
  const failFast = new AbortController();
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(options.timeoutMs ?? 3_600_000),
    failFast.signal,
  ]);
  aborted(signal);
  if (
    !Array.isArray(jobs) ||
    !jobs.length ||
    jobs.length > (options.maxQueued ?? 10000)
  )
    throw new AuditError(
      "CONFIG_INVALID",
      "Provide a nonempty batch within maxQueued.",
    );
  const sources = new Set<string>(),
    destinations = new Set<string>();
  for (const job of jobs) {
    aborted(signal);
    if (
      !job ||
      typeof job.input !== "string" ||
      typeof job.output !== "string" ||
      !["denoise", "enhance", "normalize", "convert"].includes(
        job.mode ?? "enhance",
      )
    )
      throw new AuditError(
        "CONFIG_INVALID",
        "Every job needs input, output and a valid mode.",
      );
    sources.add(await realpath(resolve(job.input)));
    const parent = await realpath(dirname(resolve(job.output)));
    const destination = join(parent, basename(job.output));
    if (destinations.has(destination))
      throw new AuditError(
        "OUTPUT_COLLISION",
        "Two batch jobs have the same output destination.",
      );
    destinations.add(destination);
    processingLimits({ ...options, ...job.options });
  }
  for (const path of destinations)
    if (sources.has(path))
      throw new AuditError(
        "OUTPUT_CLOBBER",
        "A batch output cannot replace any batch input.",
      );
  aborted(signal);
  const client = createAudioClient({ ...options, signal });
  try {
    const results = await Promise.all(
      jobs.map(async (job, index): Promise<ProcessingOutcome> => {
        try {
          const jobSignal = job.options?.signal
            ? AbortSignal.any([signal, job.options.signal])
            : signal;
          const result = await client.process(
            job.input,
            job.output,
            job.mode ?? "enhance",
            { ...job.options, signal: jobSignal },
          );
          return {
            index,
            file: basename(job.input),
            state: "completed",
            result,
          };
        } catch (e) {
          if (options.failFast) failFast.abort();
          return {
            index,
            file: basename(job.input),
            state:
              e instanceof AuditError && e.code === "CANCELLED"
                ? "cancelled"
                : "failed",
            error: errorInfo(e),
          };
        }
      }),
    );
    aborted(options.signal);
    if (signal.aborted && !failFast.signal.aborted) aborted(signal);
    return { schemaVersion: 1, kind: "processing-batch", results };
  } finally {
    await client.close();
  }
}
