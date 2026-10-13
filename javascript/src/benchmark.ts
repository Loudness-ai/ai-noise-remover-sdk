import { createReadStream } from "node:fs";
import { mkdtemp, rm, lstat, copyFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir, cpus } from "node:os";
import { join, basename } from "node:path";
import { localFile, doctor, notify, limits } from "./input.js";
import { analyze } from "./analysis.js";
import { compare } from "./compare.js";
import { checkPolicy, evaluate } from "./policy.js";
import { run } from "./process.js";
import { AuditError, aborted, integer, errorInfo } from "./errors.js";
import type {
  BenchmarkManifest,
  Benchmark,
  BenchmarkRun,
  Options,
} from "./types.js";
export function checkManifest(
  value: unknown,
): asserts value is BenchmarkManifest {
  const m = value as BenchmarkManifest;
  if (
    !m ||
    m.schemaVersion !== 1 ||
    !Array.isArray(m.fixtures) ||
    !m.fixtures.length ||
    m.fixtures.length > 1000 ||
    !Array.isArray(m.processors) ||
    !m.processors.length ||
    m.processors.length > 100 ||
    Object.keys(m).some(
      (k) =>
        ![
          "schemaVersion",
          "fixtures",
          "processors",
          "repetitions",
          "warmup",
          "policy",
          "comparison",
          "expectations",
        ].includes(k),
    )
  )
    throw new AuditError("MANIFEST_INVALID", "Invalid benchmark manifest.");
  integer(m.repetitions, "repetitions", 1, 1000);
  integer(m.warmup, "warmup", 0, 100);
  if (
    m.fixtures.length * m.processors.length * (m.repetitions + m.warmup) >
    1000
  )
    throw new AuditError(
      "MANIFEST_INVALID",
      "A manifest may schedule at most 1000 runs including warmups.",
    );
  if (
    m.expectations !== undefined &&
    (!m.expectations ||
      typeof m.expectations !== "object" ||
      Object.keys(m.expectations).some(
        (k) => !["durationToleranceSeconds", "allowDurationChange"].includes(k),
      ) ||
      (m.expectations.allowDurationChange !== undefined &&
        typeof m.expectations.allowDurationChange !== "boolean") ||
      (m.expectations.durationToleranceSeconds !== undefined &&
        (!Number.isFinite(m.expectations.durationToleranceSeconds) ||
          m.expectations.durationToleranceSeconds < 0 ||
          m.expectations.durationToleranceSeconds > 10)))
  )
    throw new AuditError(
      "MANIFEST_INVALID",
      "Invalid benchmark output expectations.",
    );
  if (m.policy) checkPolicy(m.policy);
  if (m.comparison !== undefined && typeof m.comparison !== "boolean")
    throw new AuditError("MANIFEST_INVALID", "comparison must be boolean.");
  const fixtureNames = new Set<string>();
  for (const f of m.fixtures) {
    if (
      !f ||
      typeof f.path !== "string" ||
      !f.path ||
      typeof f.license !== "string" ||
      !f.license ||
      typeof f.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(f.sha256) ||
      fixtureNames.has(basename(f.path)) ||
      Object.keys(f).some((k) => !["path", "sha256", "license"].includes(k))
    )
      throw new AuditError(
        "MANIFEST_INVALID",
        "Each fixture needs a unique basename, path, SHA-256 and license.",
      );
    fixtureNames.add(basename(f.path));
  }
  const names = new Set<string>();
  for (const p of m.processors) {
    if (
      !p ||
      typeof p.name !== "string" ||
      !p.name ||
      names.has(p.name) ||
      typeof p.executable !== "string" ||
      !p.executable ||
      !Array.isArray(p.args) ||
      !p.args.every((a) => typeof a === "string") ||
      !p.args.some((a) => a.includes("{output}")) ||
      !p.args.some((a) => a.includes("{input}")) ||
      typeof p.version !== "string" ||
      !p.version ||
      !p.settings ||
      Object.keys(p).some(
        (k) =>
          !["name", "executable", "args", "version", "settings"].includes(k),
      ) ||
      typeof p.settings !== "object" ||
      Array.isArray(p.settings) ||
      Object.values(p.settings).some(
        (v) =>
          !["string", "number", "boolean"].includes(typeof v) ||
          (typeof v === "number" && !Number.isFinite(v)),
      )
    )
      throw new AuditError(
        "MANIFEST_INVALID",
        "A processor needs a unique name, executable, input/output arguments, version and settings.",
      );
    names.add(p.name);
  }
}
async function scratchSize(directory: string): Promise<number | null> {
  let entries = 0,
    bytes = 0;
  async function visit(path: string, depth: number): Promise<void> {
    if (depth > 16) throw Error("depth");
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (++entries > 10000) throw Error("entries");
      const file = join(path, entry.name);
      if (entry.isDirectory()) await visit(file, depth + 1);
      else if (entry.isFile()) bytes += (await lstat(file)).size;
    }
  }
  try {
    await visit(directory, 0);
    return bytes;
  } catch {
    return null;
  }
}
function sampleScratch(directory: string) {
  let peak: number | null = 0,
    pending: Promise<void> | undefined,
    unavailable = false;
  const sample = () => {
    if (pending) return;
    pending = scratchSize(directory)
      .then((value) => {
        if (value === null) unavailable = true;
        else peak = Math.max(peak ?? 0, value);
      })
      .finally(() => {
        pending = undefined;
      });
  };
  sample();
  const timer = setInterval(sample, 100);
  return async () => {
    clearInterval(timer);
    await pending;
    const last = await scratchSize(directory);
    if (last === null) unavailable = true;
    else peak = Math.max(peak ?? 0, last);
    return unavailable ? null : peak;
  };
}
async function hashFile(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(file, { signal });
  try {
    for await (const chunk of stream) {
      aborted(signal);
      hash.update(chunk);
    }
  } finally {
    stream.destroy();
  }
  return hash.digest("hex");
}
function percentile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(q * s.length) - 1)];
}
export async function benchmark(
  manifest: BenchmarkManifest,
  options: Options & { allowExecution?: boolean } = {},
): Promise<Benchmark> {
  checkManifest(manifest);
  limits(options);
  const retained =
    manifest.fixtures.length *
    manifest.processors.length *
    manifest.repetitions;
  const estimatedNodes =
    retained *
    (3 *
      ((options.maxPoints ?? 64) * 16 + (options.maxEvents ?? 32) * 8 + 1200) +
      (manifest.policy?.rules.length ?? 0) * 36);
  if (estimatedNodes > 900000)
    throw new AuditError(
      "CONFIG_INVALID",
      "Retained benchmark reports exceed the report budget. Reduce repetitions, maxPoints, maxEvents or policy rules.",
    );
  if ((options.maxPoints ?? 64) > 256 || (options.maxEvents ?? 32) > 128)
    throw new AuditError(
      "CONFIG_INVALID",
      "Benchmark reports allow at most 256 points and 128 events per analysis.",
    );
  if (options.allowExecution !== true)
    throw new AuditError(
      "EXECUTION_REQUIRED",
      "Benchmark processors execute local programs. Set allowExecution explicitly.",
    );
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(options.timeoutMs ?? 3_600_000),
  ]);
  options = { maxPoints: 64, maxEvents: 32, ...options, signal };
  const deps = await doctor(options);
  if (!deps.ready)
    throw new AuditError(
      "DEPENDENCY_MISSING",
      "The configured measurement dependencies are unavailable.",
    );
  const sources: string[] = [];
  const durations: number[] = [];
  for (const fixture of manifest.fixtures) {
    const input = await localFile(fixture.path, options);
    if (
      (await hashFile(input.path, signal)).toLowerCase() !==
      fixture.sha256.toLowerCase()
    )
      throw new AuditError(
        "CHECKSUM_MISMATCH",
        "A benchmark fixture does not match its recorded SHA-256.",
      );
    sources.push(input.path);
    durations.push((await analyze(input.path, options)).durationSeconds);
  }
  const runs: BenchmarkRun[] = [];
  let completed = 0;
  const total =
    manifest.fixtures.length *
    manifest.processors.length *
    (manifest.warmup + manifest.repetitions);
  for (let f = 0; f < sources.length; f++)
    for (const processor of manifest.processors)
      for (let rep = -manifest.warmup; rep < manifest.repetitions; rep++) {
        aborted(signal);
        const scratch = await mkdtemp(join(tmpdir(), "audio-audit-benchmark-"));
        const output = join(scratch, "result.wav");
        const privateInput = join(scratch, "input-" + basename(sources[f]));
        const args = processor.args.map((arg) =>
          arg
            .replaceAll("{input}", privateInput)
            .replaceAll("{output}", output),
        );
        let record: BenchmarkRun = {
          fixture: basename(sources[f]),
          processor: processor.name,
          repetition: rep,
          temperature: rep === -manifest.warmup ? "first" : "subsequent",
          state: "failed",
          setupMs: 0,
          sampledPeakScratchBytes: null,
          scratchSamplingIntervalMs: 100,
          metrics: {
            sampledPeakTreeRssBytes: null,
            samplingIntervalMs: 100,
            parentRssBytes: process.memoryUsage().rss,
            memoryMethod: "unavailable",
            wallMs: 0,
          },
        };
        let finishSampling: (() => Promise<number | null>) | undefined;
        try {
          const setupStarted = performance.now();
          await copyFile(sources[f], privateInput);
          if (
            (await hashFile(privateInput, signal)).toLowerCase() !==
            manifest.fixtures[f].sha256.toLowerCase()
          )
            throw new AuditError(
              "INPUT_CHANGED",
              "A fixture changed while preparing this benchmark run.",
            );
          aborted(signal);
          record.setupMs = performance.now() - setupStarted;
          finishSampling = sampleScratch(scratch);
          const result = await run(processor.executable, args, {
            signal,
            timeoutMs: options.timeoutMs,
            cwd: scratch,
            measure: true,
          });
          record.metrics = result.metrics;
          const info = await lstat(output);
          if (!info.isFile() || info.size === 0)
            throw new AuditError(
              "OUTPUT_INVALID",
              "The processor did not produce a nonempty regular output file.",
            );
          const analysis = await analyze(output, {
            ...options,
            streamIndex: undefined,
          });
          if (
            (await hashFile(sources[f], signal)).toLowerCase() !==
            manifest.fixtures[f].sha256.toLowerCase()
          )
            throw new AuditError(
              "INPUT_CHANGED",
              "A reference fixture changed during this benchmark run.",
            );
          record.validation = evaluate(
            analysis,
            manifest.policy ?? {
              schemaVersion: 1,
              name: "Decoded output coverage",
              rules: [{ metric: "durationSeconds", min: 1e-6 }],
            },
          );
          const durationValid =
            manifest.expectations?.allowDurationChange === true ||
            Math.abs(analysis.durationSeconds - durations[f]) <=
              (manifest.expectations?.durationToleranceSeconds ?? 0.05);
          if (manifest.comparison !== false)
            record.comparison = await compare(sources[f], output, options);
          record.state =
            record.validation.failed || !durationValid ? "failed" : "completed";
          if (!durationValid)
            record.error = {
              code: "OUTPUT_COVERAGE",
              message:
                "The processor output did not preserve the required recording duration.",
            };
          else if (record.validation.failed)
            record.error = {
              code: "POLICY_FAILED",
              message: "The output did not meet the benchmark policy.",
            };
        } catch (e) {
          aborted(signal);
          record.error = errorInfo(e);
        } finally {
          if (finishSampling)
            record.sampledPeakScratchBytes = await finishSampling();
          await rm(scratch, { recursive: true, force: true });
        }
        if (rep >= 0) runs.push(record);
        completed++;
        notify(options, { phase: "benchmark", fraction: completed / total });
      }
  const summaries: Benchmark["summaries"] = [];
  for (const fixture of manifest.fixtures)
    for (const processor of manifest.processors) {
      const group = runs.filter(
        (r) =>
          r.fixture === basename(fixture.path) &&
          r.processor === processor.name,
      );
      const times = group
        .filter((r) => r.state === "completed")
        .map((r) => r.metrics.wallMs);
      summaries.push({
        fixture: basename(fixture.path),
        processor: processor.name,
        successes: times.length,
        failures: group.length - times.length,
        medianMs: percentile(times, 0.5),
        p95Ms: times.length >= 20 ? percentile(times, 0.95) : null,
      });
    }
  const publicManifest = structuredClone(manifest);
  publicManifest.fixtures = publicManifest.fixtures.map((f) => ({
    ...f,
    path: basename(f.path),
  }));
  publicManifest.processors = publicManifest.processors.map((p) => ({
    ...p,
    executable: basename(p.executable),
  }));
  return {
    schemaVersion: 1,
    kind: "benchmark",
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpus: cpus()[0]?.model ?? "unknown",
      cpuCount: cpus().length,
      nativeVersions: deps.versions,
    },
    manifest: publicManifest,
    runs,
    summaries,
    limitations: [
      "Process-tree memory is sampled every 100 ms; short-lived peaks may be missed. Parent RSS is a separate observation, not a peak sum.",
      "Scratch logical file bytes are sampled every 100 ms, include the private input copy and exclude external caches. Symlinks are not followed. Excessive directory size/depth or sampling errors make disk use unavailable.",
      "First/subsequent describes process launch order, not proven cold/warm filesystem or model-cache state. Externally managed worker memory is not captured.",
      "p95 is unavailable below 20 successful measured repetitions. Wall time excludes input-copy setup and output analysis/comparison and includes processor startup; setup is recorded separately.",
      "Different processor models, precision and settings represent different workloads; these results alone do not establish subjective quality.",
    ],
  };
}
