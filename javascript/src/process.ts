import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { AuditError, aborted } from "./errors.js";
import type { ProcessMetrics } from "./types.js";

interface RunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  onChunk?: (chunk: Buffer) => void | Promise<void>;
  onLine?: (line: string) => void;
  onStdoutLine?: (line: string) => void;
  cwd?: string;
  measure?: boolean;
  maxRssBytes?: number;
}
async function consumeWithCancellation(
  value: void | Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (!value) return;
  aborted(signal);
  let rejectAbort: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    rejectAbort = () => {
      try {
        aborted(signal);
      } catch (e) {
        reject(e);
      }
    };
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    await Promise.race([value, interrupted]);
  } finally {
    signal.removeEventListener("abort", rejectAbort!);
  }
}
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
async function stopTree(owner: ChildProcess): Promise<void> {
  const pid = owner.pid!;
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        shell: false,
      });
      killer.once("error", reject);
      killer.once("close", (code) => {
        if (code !== 0 && owner.exitCode === null && owner.signalCode === null)
          reject(
            new AuditError(
              "TERMINATION_FAILED",
              "Could not stop an owned process tree.",
            ),
          );
        else resolve();
      });
    });
    return;
  }
  const signalOwner = (signal: NodeJS.Signals): void => {
    if (owner.exitCode !== null || owner.signalCode !== null) return;
    try {
      owner.kill(signal);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH")
        throw new AuditError(
          "TERMINATION_FAILED",
          "Could not signal an owned process.",
          { cause: e },
        );
    }
  };
  const send = async (signal: NodeJS.Signals): Promise<void> => {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        process.kill(-pid, signal);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          signalOwner(signal);
          return;
        }
        if (code !== "EPERM")
          throw new AuditError(
            "TERMINATION_FAILED",
            "Could not signal an owned process group.",
            { cause: e },
          );
        // macOS can temporarily deny a group signal while posix_spawn establishes it.
        await delay(10);
      }
    }
    // Signal only the still-owned child as a fallback, then verify its entire group below.
    signalOwner(signal);
  };
  await send("SIGTERM");
  for (let i = 0; i < 10 && groupAlive(pid); i++) await delay(25);
  if (groupAlive(pid)) await send("SIGKILL");
  for (let i = 0; i < 80 && groupAlive(pid); i++) await delay(25);
  if (groupAlive(pid))
    if (await hasLiveGroupMember(pid))
      throw new AuditError(
        "TERMINATION_FAILED",
        "An owned process group did not terminate.",
      );
}
// Orphaned zombies can retain a process-group ID under container PID 1, but do no work.
// Check state rather than reporting a false termination failure after SIGKILL.
async function hasLiveGroupMember(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const ps = spawn("ps", ["-axo", "pgid=,stat="], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
    });
    let output = "",
      limited = false;
    const timer = setTimeout(() => {
      ps.kill("SIGKILL");
      resolve(true);
    }, 1000);
    ps.stdout.on("data", (chunk) => {
      if (output.length < 4_000_000) output += chunk.toString();
      else limited = true;
    });
    ps.once("error", () => {
      clearTimeout(timer);
      resolve(true);
    });
    ps.once("close", (code) => {
      clearTimeout(timer);
      resolve(
        code !== 0 ||
          limited ||
          output.split("\n").some((line) => {
            const [group, state] = line.trim().split(/\s+/);
            return Number(group) === pid && !state.startsWith("Z");
          }),
      );
    });
  });
}
async function treeRss(pid: number): Promise<number | null> {
  if (process.platform === "win32") return null;
  return new Promise((resolve) => {
    const ps = spawn("ps", ["-axo", "pid=,ppid=,pgid=,rss="], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
    });
    let text = "";
    const timer = setTimeout(() => {
      ps.kill("SIGKILL");
      resolve(null);
    }, 1000);
    ps.stdout.on("data", (chunk: Buffer) => {
      if (text.length < 4_000_000) text += chunk.toString();
    });
    ps.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    ps.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      let sum = 0;
      let found = false;
      for (const line of text.split("\n")) {
        const values = line.trim().split(/\s+/).map(Number);
        if (values[2] === pid) {
          found = true;
          sum += values[3] * 1024;
        }
      }
      resolve(found ? sum : null);
    });
  });
}
/** No shell, bounded capture, and a physical completion fence for owned processes. */
export async function run(
  executable: string,
  args: string[],
  options: RunOptions = {},
): Promise<{ stdout: Buffer; stderr: string; metrics: ProcessMetrics }> {
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(options.timeoutMs ?? 3_600_000),
  ]);
  aborted(signal);
  const started = performance.now();
  const child = spawn(executable, args, {
    shell: false,
    detached: process.platform !== "win32",
    windowsHide: true,
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LC_ALL: "C", AV_LOG_FORCE_NOCOLOR: "1" },
  });
  let failure: unknown;
  let stderr = "";
  let lineBuffer = "";
  let stdoutLineBuffer = "";
  let size = 0;
  let peak: number | null = null;
  let stopPromise: Promise<void> | undefined;
  let closeAfterStopFailure: (() => void) | undefined;
  let sampling = false;
  let samplePromise: Promise<void> | undefined;
  const stop = (): void => {
    if (child.pid && !stopPromise) {
      stopPromise = stopTree(child);
      void stopPromise.catch((e) => {
        failure = e;
        child.stdout.destroy();
        child.stderr.destroy();
        closeAfterStopFailure?.();
        child.unref();
      });
    }
  };
  const interrupted = (): void => {
    try {
      aborted(signal);
    } catch (e) {
      failure ??= e;
    }
    stop();
  };
  signal.addEventListener("abort", interrupted, { once: true });
  const closed = new Promise<number | null>((resolve) => {
    closeAfterStopFailure = () => resolve(null);
    child.once("error", (e) => {
      failure ??= new AuditError(
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? "DEPENDENCY_MISSING"
          : "SPAWN_FAILED",
        "Could not start the configured executable.",
        { cause: e },
      );
    });
    child.once("close", resolve);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-65536);
    if (options.onLine) {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop()!.slice(-16384);
      try {
        for (const line of lines) options.onLine(line.slice(0, 16384));
      } catch (e) {
        failure ??= e;
        stop();
      }
    }
  });
  const sampler =
    options.measure || options.maxRssBytes
      ? setInterval(() => {
          if (sampling || !child.pid) return;
          sampling = true;
          samplePromise = treeRss(child.pid)
            .then((value) => {
              if (value !== null) peak = Math.max(peak ?? 0, value);
              if (
                value !== null &&
                options.maxRssBytes &&
                value > options.maxRssBytes
              ) {
                failure ??= new AuditError(
                  "MEMORY_LIMIT",
                  "The processing job exceeded its configured sampled memory budget.",
                );
                stop();
              }
            })
            .finally(() => {
              sampling = false;
            });
        }, 100)
      : undefined;
  const buffers: Buffer[] = [];
  try {
    try {
      for await (const chunk of child.stdout) {
        if (failure) break;
        if (options.onStdoutLine) {
          stdoutLineBuffer += (chunk as Buffer).toString();
          const lines = stdoutLineBuffer.split("\n");
          stdoutLineBuffer = lines.pop()!.slice(-16384);
          for (const line of lines) options.onStdoutLine(line.slice(0, 16384));
        }
        if (options.onChunk)
          await consumeWithCancellation(
            options.onChunk(chunk as Buffer),
            signal,
          );
        else {
          size += (chunk as Buffer).length;
          if (size > (options.maxStdoutBytes ?? 1_048_576))
            throw new AuditError(
              "OUTPUT_LIMIT",
              "Executable output exceeded the capture limit.",
            );
          buffers.push(chunk as Buffer);
        }
      }
    } catch (e) {
      failure ??= e;
      stop();
    }
    const code = await closed;
    if (sampler) clearInterval(sampler);
    await samplePromise;
    if (child.pid && process.platform !== "win32" && groupAlive(child.pid))
      stop();
    if (stopPromise) await stopPromise;
    if (failure) throw failure;
    aborted(signal);
    if (code !== 0)
      throw new AuditError(
        "PROCESS_FAILED",
        "The executable exited unsuccessfully.",
      );
    return {
      stdout: Buffer.concat(buffers),
      stderr,
      metrics: {
        sampledPeakTreeRssBytes: peak,
        samplingIntervalMs: 100,
        parentRssBytes: process.memoryUsage().rss,
        wallMs: performance.now() - started,
        memoryMethod:
          peak === null ? "unavailable" : "sampled-process-group-rss",
      },
    };
  } finally {
    if (sampler) clearInterval(sampler);
    await samplePromise;
    signal.removeEventListener("abort", interrupted);
    if (failure && child.pid) {
      stop();
      if (stopPromise) await stopPromise;
    }
  }
}
