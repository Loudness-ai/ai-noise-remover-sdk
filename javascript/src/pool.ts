import { availableParallelism } from "node:os";
import { randomUUID } from "node:crypto";
import { analyze } from "./analysis.js";
import { compare } from "./compare.js";
import { validate, checkPolicy } from "./policy.js";
import { inspect, limits } from "./input.js";
import { AuditError, integer, aborted, observe } from "./errors.js";
import type { Options, Policy, CompareOptions } from "./types.js";
export interface PoolOptions extends Options {
  concurrency?: number;
  maxQueued?: number;
  maxNativeThreads?: number;
  onState?: (event: {
    id: string;
    state: "queued" | "running" | "completed" | "failed" | "cancelled";
  }) => void;
}
interface Queued {
  start: () => void;
  cancel: () => void;
}
/** An owner-scoped scheduler shared across all methods on this client. */
export class Auditor {
  readonly concurrency: number;
  private queue: Queued[] = [];
  private active = 0;
  private closing = false;
  private controller = new AbortController();
  private waiters: (() => void)[] = [];
  constructor(private readonly settings: PoolOptions = {}) {
    limits(settings);
    const threads = integer(
      settings.nativeThreads ?? 1,
      "nativeThreads",
      1,
      256,
    );
    const budget = integer(
      settings.maxNativeThreads ?? 256,
      "maxNativeThreads",
      1,
      65536,
    );
    this.concurrency = integer(
      settings.concurrency ?? Math.min(8, availableParallelism()),
      "concurrency",
      1,
      256,
    );
    if (this.concurrency * threads > budget)
      throw new AuditError(
        "CONFIG_INVALID",
        "concurrency × nativeThreads exceeds maxNativeThreads.",
      );
    integer(settings.maxQueued ?? 10000, "maxQueued", 1, 100000);
  }
  get state(): { active: number; queued: number; closed: boolean } {
    return {
      active: this.active,
      queued: this.queue.length,
      closed: this.closing,
    };
  }
  protected schedule<T>(
    task: (options: Options) => Promise<T>,
    options: Options = {},
  ): Promise<T> {
    try {
      limits({ ...this.settings, ...options });
      if (
        options.nativeThreads !== undefined &&
        options.nativeThreads !== (this.settings.nativeThreads ?? 1)
      )
        throw new AuditError(
          "CONFIG_INVALID",
          "Per-job nativeThreads cannot override this auditor's configured thread count.",
        );
    } catch (e) {
      return Promise.reject(e);
    }
    if (this.closing)
      return Promise.reject(
        new AuditError("POOL_CLOSED", "This auditor is closed."),
      );
    if (this.queue.length >= (this.settings.maxQueued ?? 10000))
      return Promise.reject(
        new AuditError("QUEUE_LIMIT", "The auditor queue is full."),
      );
    const signal = AbortSignal.any([
      this.controller.signal,
      ...(this.settings.signal ? [this.settings.signal] : []),
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(
        options.timeoutMs ?? this.settings.timeoutMs ?? 3_600_000,
      ),
    ]);
    try {
      aborted(signal);
    } catch (e) {
      return Promise.reject(e);
    }
    const id = randomUUID();
    const event = (
      state: "queued" | "running" | "completed" | "failed" | "cancelled",
    ): void => {
      observe(() => this.settings.onState?.({ id, state }));
    };
    return new Promise<T>((resolve, reject) => {
      const job: Queued = {
        start: () => {
          signal.removeEventListener("abort", job.cancel);
          this.active++;
          event("running");
          void Promise.resolve()
            .then(() =>
              task({
                ...this.settings,
                ...options,
                nativeThreads: this.settings.nativeThreads ?? 1,
                signal,
              }),
            )
            .then(
              (value) => {
                this.active--;
                event("completed");
                this.pump();
                resolve(value);
              },
              (e) => {
                this.active--;
                event(
                  e instanceof AuditError && e.code === "CANCELLED"
                    ? "cancelled"
                    : "failed",
                );
                this.pump();
                reject(e);
              },
            );
        },
        cancel: () => {
          const index = this.queue.indexOf(job);
          if (index < 0) return;
          this.queue.splice(index, 1);
          signal.removeEventListener("abort", job.cancel);
          let error;
          try {
            aborted(signal);
          } catch (e) {
            error = e;
          }
          event(
            error instanceof AuditError && error.code === "CANCELLED"
              ? "cancelled"
              : "failed",
          );
          reject(error);
          this.pump();
        },
      };
      this.queue.push(job);
      signal.addEventListener("abort", job.cancel, { once: true });
      event("queued");
      if (signal.aborted) job.cancel();
      this.pump();
    });
  }
  private pump(): void {
    while (!this.closing && this.active < this.concurrency && this.queue.length)
      this.queue.shift()!.start();
    if (!this.active && !this.queue.length)
      for (const resolve of this.waiters.splice(0)) resolve();
  }
  analyze(file: string, options: Options = {}) {
    return this.schedule((o) => analyze(file, o), options);
  }
  inspect(file: string, options: Options = {}) {
    return this.schedule((o) => inspect(file, o), options);
  }
  validate(file: string, policy: Policy, options: Options = {}) {
    try {
      checkPolicy(policy);
    } catch (e) {
      return Promise.reject(e);
    }
    return this.schedule((o) => validate(file, policy, o), options);
  }
  compare(before: string, after: string, options: CompareOptions = {}) {
    return this.schedule(
      (o) => compare(before, after, { ...options, ...o }),
      options,
    );
  }
  async close(): Promise<void> {
    this.closing = true;
    this.controller.abort();
    if (this.active || this.queue.length)
      await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
}
export function createAuditor(options: PoolOptions = {}): Auditor {
  return new Auditor(options);
}
