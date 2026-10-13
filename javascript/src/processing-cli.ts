import { parseArgs } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { processBatch } from "./audio-client.js";
import { processAudio } from "./processing.js";
import type {
  ProcessingOptions,
  ProcessingMode,
  OutputFormat,
} from "./processing.js";
import { AuditError } from "./errors.js";
import { processingDoctor } from "./processing-doctor.js";
export const processingCommands = new Set([
  "denoise",
  "enhance",
  "normalize",
  "convert",
  "process-batch",
  "processing-doctor",
]);
export async function processingMain(args: string[]): Promise<void> {
  const strings = [
    "output",
    "format",
    "bit-depth",
    "bitrate",
    "sample-rate",
    "channels",
    "strength",
    "target-lufs",
    "true-peak",
    "loudness-range",
    "max-bytes",
    "max-duration",
    "timeout-ms",
    "max-temp-bytes",
    "memory-mib",
    "native-threads",
    "stream-index",
    "model-dir",
    "temp-dir",
    "ffmpeg",
    "ffprobe",
    "concurrency",
    "total-memory-mib",
  ];
  const booleans = [
    "json",
    "progress",
    "overwrite",
    "no-normalize",
    "no-voice-processing",
    "help",
    "fail-fast",
  ];
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: Object.fromEntries([
      ...strings.map((key) => [key, { type: "string" }]),
      ...booleans.map((key) => [key, { type: "boolean" }]),
    ]) as Record<string, { type: "string" | "boolean" }>,
  });
  if (values.help) {
    process.stdout.write(
      `Usage: loudness-audio ${positionals[0]} INPUT --output OUTPUT [options]\nLocal processing; no account or network request.\n--format wav|flac|mp3|opus --bit-depth 16|24 --bitrate KBPS\n--sample-rate HZ --channels N --strength 0..1\n--target-lufs LUFS --true-peak DBTP --loudness-range LU\n--no-normalize --no-voice-processing\n--max-bytes N --max-duration SECONDS --timeout-ms N\n--max-temp-bytes N --memory-mib N --native-threads N\n--stream-index N --model-dir PATH --temp-dir PATH\n--ffmpeg PATH --ffprobe PATH --overwrite --json --progress\n`,
    );
    return;
  }
  const isBatch = positionals[0] === "process-batch";
  const isDoctor = positionals[0] === "processing-doctor";
  if (
    isDoctor
      ? positionals.length !== 1 || values.output !== undefined
      : positionals.length !== 2 ||
        !processingCommands.has(positionals[0]) ||
        (!isBatch && typeof values.output !== "string")
  )
    throw new AuditError(
      "CONFIG_INVALID",
      "Processing requires an input and --output FILE, or process-batch MANIFEST.",
    );
  if (isBatch && values.output)
    throw new AuditError(
      "CONFIG_INVALID",
      "Batch output files belong in the manifest.",
    );
  if (
    !isBatch &&
    ["concurrency", "total-memory-mib", "fail-fast"].some(
      (key) => values[key] !== undefined,
    )
  )
    throw new AuditError(
      "CONFIG_INVALID",
      "Batch scheduling options require process-batch.",
    );
  const number = (key: string): number | undefined => {
    if (values[key] === undefined) return undefined;
    if (
      typeof values[key] !== "string" ||
      !values[key]!.toString().trim() ||
      !Number.isFinite(Number(values[key]))
    )
      throw new AuditError(
        "CONFIG_INVALID",
        `Invalid numeric option: --${key}.`,
      );
    return Number(values[key]);
  };
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const options: ProcessingOptions = {
      signal: controller.signal,
      overwrite: !!values.overwrite,
      format: values.format as OutputFormat | undefined,
      bitDepth: number("bit-depth") as 16 | 24 | undefined,
      bitrateKbps: number("bitrate"),
      sampleRate: number("sample-rate"),
      channels: number("channels"),
      strength: number("strength"),
      targetLufs: number("target-lufs"),
      truePeakDbtp: number("true-peak"),
      loudnessRangeLu: number("loudness-range"),
      maxFileBytes: number("max-bytes"),
      maxDurationSeconds: number("max-duration"),
      timeoutMs: number("timeout-ms"),
      maxTempBytes: number("max-temp-bytes"),
      memoryBudgetMiB: number("memory-mib"),
      nativeThreads: number("native-threads"),
      streamIndex: number("stream-index"),
      modelDir: values["model-dir"] as string | undefined,
      tempDirectory: values["temp-dir"] as string | undefined,
      ffmpegPath: values.ffmpeg as string | undefined,
      ffprobePath: values.ffprobe as string | undefined,
      ...(values["no-normalize"] ? { normalize: false } : {}),
      ...(values["no-voice-processing"] ? { voiceProcessing: false } : {}),
      onProgress: values.progress
        ? (event) =>
            process.stderr.write(
              `${event.phase}${event.fraction === null ? "" : " " + Math.floor(event.fraction * 100) + "%"}\n`,
            )
        : undefined,
    };
    if (isDoctor) {
      const result = await processingDoctor(options);
      process.stdout.write(
        values.json
          ? JSON.stringify(result, null, 2) + "\n"
          : `${result.ready ? "Local audio processing is ready." : "Local audio processing is unavailable."}\n${result.errors.join("\n")}\n`,
      );
      process.exitCode = result.ready ? 0 : 4;
      return;
    }
    if (isBatch) {
      const manifest = resolve(positionals[1]);
      const info = await stat(manifest);
      if (!info.isFile() || info.size > 10485760)
        throw new AuditError(
          "CONFIG_INVALID",
          "The processing manifest exceeds its file limit.",
        );
      let jobs;
      try {
        jobs = JSON.parse(await readFile(manifest, "utf8"));
      } catch {
        throw new AuditError(
          "CONFIG_INVALID",
          "The processing manifest is invalid JSON.",
        );
      }
      if (!Array.isArray(jobs))
        throw new AuditError(
          "CONFIG_INVALID",
          "The processing manifest must be an array of jobs.",
        );
      for (const job of jobs) {
        if (
          !job ||
          typeof job.input !== "string" ||
          typeof job.output !== "string"
        )
          throw new AuditError(
            "CONFIG_INVALID",
            "Every processing job requires input and output paths.",
          );
        job.input = resolve(dirname(manifest), job.input);
        job.output = resolve(dirname(manifest), job.output);
      }
      const result = await processBatch(jobs, {
        ...options,
        concurrency: number("concurrency"),
        totalMemoryBudgetMiB: number("total-memory-mib"),
        failFast: !!values["fail-fast"],
      });
      process.stdout.write(
        values.json
          ? JSON.stringify(result, null, 2) + "\n"
          : result.results
              .map((entry) => `${entry.file}: ${entry.state}`)
              .join("\n") + "\n",
      );
      process.exitCode = result.results.every(
        (entry) => entry.state === "completed",
      )
        ? 0
        : 4;
      return;
    }
    const result = await processAudio(
      positionals[1],
      values.output as string,
      positionals[0] as ProcessingMode,
      options,
    );
    process.stdout.write(
      values.json
        ? JSON.stringify(result, null, 2) + "\n"
        : `Saved ${result.output.name}\nDuration: ${result.output.durationSeconds.toFixed(3)} s\nLoudness: ${result.analysis.integratedLufs ?? "unavailable"} LUFS\n${result.warnings.map((warning) => `Warning: ${warning}\n`).join("")}`,
    );
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
