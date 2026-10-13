#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { inspect, doctor } from "./input.js";
import { analyze } from "./analysis.js";
import { validate, checkPolicy } from "./policy.js";
import { compare } from "./compare.js";
import { batch } from "./batch.js";
import { benchmark, checkManifest } from "./benchmark.js";
import { renderHtml, checkReport } from "./report.js";
import { writeAtomic } from "./atomic.js";
import { AuditError, errorInfo } from "./errors.js";
import type { Options, Report, CompareOptions, BatchOptions } from "./types.js";
import { processingCommands, processingMain } from "./processing-cli.js";
const help = `Loudness.ai Audio Kit 1.0.0
Usage: loudness-audio <command> [files] [options]
  denoise FILE --output FILE      Remove speech background noise locally
  enhance FILE --output FILE      Clean speech and prepare its level locally
  normalize FILE --output FILE    Prepare a configurable loudness target
  convert FILE --output FILE      Export WAV, FLAC, MP3 or Opus
  process-batch MANIFEST          Process ordered local jobs with shared admission
  processing-doctor              Exercise installed local speech processing
  doctor                         Check local native dependencies
  inspect FILE                   Inspect audio streams and format
  analyze FILE                   Measure the complete recording
  validate FILE --policy JSON    Check configured delivery requirements
  compare BEFORE AFTER           Measure changes and sampled alignment
  batch FILE...                  Analyze files with bounded concurrency
  benchmark MANIFEST --execute   Run trusted local processor commands
  report JSON                    Render an existing report as offline HTML
Options:
  --json                         Emit machine-readable JSON
  --output PATH                  Atomically write JSON (HTML for report)
  --html PATH                    Also write a self-contained HTML report
  --overwrite                    Deliberately replace report files
  --policy PATH                  Versioned JSON validation policy
  --stream-index N               Absolute audio stream index
  --timeout-ms N                 Whole-operation timeout (default 3600000)
  --max-duration N               Analysis duration limit in seconds (86400)
  --max-bytes N                  Input byte limit (10737418240)
  --concurrency N                Batch active jobs (default CPU-based, up to 8)
  --native-threads N             Decoder thread count per job (1)
  --max-points N                 Bounded timeline/waveform points (2048)
  --silence-db N                 Quiet-window threshold (-60 dBFS)
  --tolerance N                  Comparison duration/timing tolerance (0.05 s)
  --max-alignment N              Alignment search radius (0.5 s; max 2)
  --allow-trim --allow-gain --allow-resample --allow-channels
  --fail-fast                    Cancel remaining batch jobs on failure
  --ffmpeg PATH --ffprobe PATH   Explicit native executable paths
  --progress                     Progress on stderr
  --help --version
Use -- before a filename beginning with a hyphen. No source file is rewritten.
Exit codes: 0 success, 2 configured policy failure, 3 invalid invocation,
4 processing failure, 130 cancellation, 124 timeout.
`;
async function jsonFile(file: string, maxBytes = 10_485_760): Promise<unknown> {
  const info = await stat(file);
  if (!info.isFile() || info.size > maxBytes)
    throw new AuditError(
      "CONFIG_INVALID",
      "JSON input exceeds its configured byte limit or is not a regular file.",
    );
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new AuditError("CONFIG_INVALID", "Could not parse JSON input.");
  }
}
async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: Object.fromEntries([
      ...[
        "json",
        "overwrite",
        "execute",
        "progress",
        "help",
        "version",
        "fail-fast",
        "allow-trim",
        "allow-gain",
        "allow-resample",
        "allow-channels",
      ].map((k) => [k, { type: "boolean" }]),
      ...[
        "output",
        "html",
        "policy",
        "stream-index",
        "timeout-ms",
        "max-duration",
        "max-bytes",
        "concurrency",
        "native-threads",
        "max-points",
        "silence-db",
        "tolerance",
        "max-alignment",
        "ffmpeg",
        "ffprobe",
      ].map((k) => [k, { type: "string" }]),
    ]) as Record<string, { type: "boolean" | "string" }>,
  });
  if (values.version) {
    process.stdout.write("1.0.0\n");
    return;
  }
  if (values.help || !positionals.length) {
    process.stdout.write(help);
    return;
  }
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const numeric = (key: string): number | undefined => {
    if (values[key] === undefined) return undefined;
    const n = Number(values[key]);
    if (!Number.isFinite(n))
      throw new AuditError("CONFIG_INVALID", `Invalid numeric option: ${key}.`);
    return n;
  };
  const options: Options = {
    signal: controller.signal,
    ffmpegPath: values.ffmpeg as string | undefined,
    ffprobePath: values.ffprobe as string | undefined,
    timeoutMs: numeric("timeout-ms"),
    maxDurationSeconds: numeric("max-duration"),
    maxFileBytes: numeric("max-bytes"),
    streamIndex: numeric("stream-index"),
    nativeThreads: numeric("native-threads"),
    maxPoints: numeric("max-points"),
    silenceThresholdDbfs: numeric("silence-db"),
    onProgress: values.progress
      ? (p) => {
          process.stderr.write(
            `${p.phase} ${p.fraction === null ? "" : Math.floor(p.fraction * 100) + "%"}\n`,
          );
        }
      : undefined,
  };
  const [command, ...files] = positionals;
  const shared = ["json", "output", "overwrite", "help", "version"];
  const native = [
    "ffmpeg",
    "ffprobe",
    "timeout-ms",
    "max-duration",
    "max-bytes",
    "stream-index",
    "native-threads",
    "progress",
  ];
  const measurements = [...native, "max-points", "silence-db", "html"];
  const allowed: Record<string, string[]> = {
    doctor: ["ffmpeg", "ffprobe", "timeout-ms"],
    inspect: [...native, "html"],
    analyze: measurements,
    validate: [...measurements, "policy"],
    compare: [
      ...measurements,
      "tolerance",
      "max-alignment",
      "allow-trim",
      "allow-gain",
      "allow-resample",
      "allow-channels",
    ],
    batch: [...measurements, "concurrency", "fail-fast"],
    benchmark: [...measurements, "execute"],
    report: ["html"],
  };
  for (const option of Object.keys(values))
    if (!shared.includes(option) && !allowed[command]?.includes(option))
      throw new AuditError(
        "CONFIG_INVALID",
        `Option --${option} is not valid for ${command}.`,
      );
  let result: Report | Awaited<ReturnType<typeof doctor>>;
  let code = 0;
  const requireFiles = (n: number): void => {
    if (files.length !== n)
      throw new AuditError(
        "CONFIG_INVALID",
        `${command} expects ${n} file argument(s).`,
      );
  };
  try {
    switch (command) {
      case "doctor":
        requireFiles(0);
        result = await doctor(options);
        code = result.ready ? 0 : 4;
        break;
      case "inspect":
        requireFiles(1);
        result = await inspect(files[0], options);
        break;
      case "analyze":
        requireFiles(1);
        result = await analyze(files[0], options);
        break;
      case "validate": {
        requireFiles(1);
        if (typeof values.policy !== "string")
          throw new AuditError("POLICY_INVALID", "validate requires --policy.");
        const p = await jsonFile(values.policy);
        checkPolicy(p);
        result = await validate(files[0], p, options);
        code = result.failed ? 2 : 0;
        break;
      }
      case "compare": {
        requireFiles(2);
        const opts: CompareOptions = {
          ...options,
          toleranceSeconds: numeric("tolerance"),
          maxAlignmentSeconds: numeric("max-alignment"),
          allow: {
            trim: !!values["allow-trim"],
            gain: !!values["allow-gain"],
            resample: !!values["allow-resample"],
            channels: !!values["allow-channels"],
          },
        };
        result = await compare(files[0], files[1], opts);
        break;
      }
      case "batch": {
        if (!files.length)
          throw new AuditError("CONFIG_INVALID", "batch needs file arguments.");
        const opts: BatchOptions = {
          ...options,
          concurrency: numeric("concurrency"),
          failFast: !!values["fail-fast"],
        };
        result = await batch(files, opts);
        code = result.results.some((r) => r.state !== "completed") ? 4 : 0;
        break;
      }
      case "benchmark": {
        requireFiles(1);
        const m = await jsonFile(files[0]);
        checkManifest(m);
        result = await benchmark(m, {
          ...options,
          allowExecution: !!values.execute,
        });
        code = result.runs.some((r) => r.state === "failed") ? 2 : 0;
        break;
      }
      case "report":
        requireFiles(1);
        result = (await jsonFile(files[0], 67_108_864)) as Report;
        checkReport(result);
        break;
      default:
        throw new AuditError("CONFIG_INVALID", "Unknown command; use --help.");
    }
    const raw = JSON.stringify(result, null, 2) + "\n";
    const destinations = [values.output, values.html].filter(
      (v): v is string => typeof v === "string",
    );
    for (const destination of destinations) {
      const target = await realpath(destination).catch(() =>
        resolve(destination),
      );
      for (const file of files) {
        const source = await realpath(file).catch(() => resolve(file));
        if (target === source)
          throw new AuditError(
            "OUTPUT_SOURCE",
            "A report destination cannot replace an input.",
          );
      }
    }
    if (
      destinations.length === 2 &&
      resolve(destinations[0]) === resolve(destinations[1])
    )
      throw new AuditError(
        "CONFIG_INVALID",
        "JSON and HTML destinations must differ.",
      );
    if (typeof values.output === "string")
      await writeAtomic(
        values.output,
        command === "report" ? renderHtml(result as Report) : raw,
        { overwrite: !!values.overwrite, signal: controller.signal },
      );
    if (typeof values.html === "string")
      await writeAtomic(values.html, renderHtml(result as Report), {
        overwrite: !!values.overwrite,
        signal: controller.signal,
      });
    if (!values.output)
      process.stdout.write(
        command === "report"
          ? renderHtml(result as Report)
          : values.json
            ? raw
            : terminal(result),
      );
    process.exitCode = code;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
function terminal(r: Report | Awaited<ReturnType<typeof doctor>>): string {
  if (!("kind" in r))
    return `Dependencies: ${r.ready ? "ready" : "unavailable"}\n${Object.values(r.versions).join("\n")}\n${r.errors.join("\n")}\n`;
  if (r.kind === "analysis")
    return `${r.input.file.name}\nDuration: ${r.durationSeconds.toFixed(3)} s\nLoudness: ${r.integratedLufs ?? "unavailable"} LUFS\nTrue peak: ${r.truePeakDbtp ?? "unavailable"} dBTP\nChannels: ${r.channels.length}\nState: ${r.state}\n`;
  if (r.kind === "batch")
    return r.results.map((v) => `${v.file}: ${v.state}`).join("\n") + "\n";
  return JSON.stringify(r, null, 2) + "\n";
}
void (
  processingCommands.has(process.argv[2])
    ? processingMain(process.argv.slice(2))
    : main()
).catch((e) => {
  const info = errorInfo(
    e instanceof AuditError
      ? e
      : typeof e?.code === "string" && e.code.startsWith("ERR_PARSE_ARGS")
        ? new AuditError("CONFIG_INVALID", "Invalid invocation; use --help.")
        : e,
  );
  process.stderr.write(JSON.stringify(info) + "\n");
  process.exitCode =
    info.code === "CANCELLED"
      ? 130
      : info.code === "TIMEOUT"
        ? 124
        : [
              "CONFIG_INVALID",
              "POLICY_INVALID",
              "MANIFEST_INVALID",
              "EXECUTION_REQUIRED",
              "STREAM_REQUIRED",
              "STREAM_INVALID",
            ].includes(info.code)
          ? 3
          : 4;
});
