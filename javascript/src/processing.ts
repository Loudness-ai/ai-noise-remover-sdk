import {
  mkdtemp,
  rm,
  lstat,
  stat,
  realpath,
  open,
  link,
  unlink,
  rename,
} from "node:fs/promises";
import { join, dirname, basename, resolve, extname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { inspect, localFile, limits, notify } from "./input.js";
import { analyze } from "./analysis.js";
import { run } from "./process.js";
import { AuditError, aborted, integer } from "./errors.js";
import type { Analysis, Inspection, Options, ProcessMetrics } from "./types.js";

export type ProcessingMode = "denoise" | "enhance" | "normalize" | "convert";
export type OutputFormat = "wav" | "flac" | "mp3" | "opus";
export interface ProcessingOptions extends Options {
  format?: OutputFormat;
  bitDepth?: 16 | 24;
  bitrateKbps?: number;
  sampleRate?: number;
  channels?: number;
  strength?: number;
  targetLufs?: number;
  truePeakDbtp?: number;
  loudnessRangeLu?: number;
  normalize?: boolean;
  voiceProcessing?: boolean;
  overwrite?: boolean;
  modelDir?: string;
  tempDirectory?: string;
  maxTempBytes?: number;
  memoryBudgetMiB?: number;
}
export interface ProcessingResult {
  schemaVersion: 1;
  kind: "processing";
  mode: ProcessingMode;
  input: Inspection;
  output: {
    path: string;
    name: string;
    sizeBytes: number;
    format: OutputFormat;
    sampleRate: number;
    channels: number;
    durationSeconds: number;
  };
  settings: {
    strength: number;
    voiceProcessing: boolean;
    normalized: boolean;
    targetLufs: number | null;
    truePeakDbtp: number | null;
  };
  analysis: Analysis;
  warnings: string[];
  metrics: {
    wallMs: number;
    initializedMs: number;
    inferenceWallMs: number;
    sampledPeakTreeRssBytes: number | null;
    samplingIntervalMs: number;
    temporaryAudioBytes: number;
    memoryMethod: string;
  };
}
export function processingLimits(options: ProcessingOptions): void {
  limits(options);
  const range = (
    v: number | undefined,
    name: string,
    low: number,
    high: number,
  ) => {
    if (v !== undefined && (!Number.isFinite(v) || v < low || v > high))
      throw new AuditError(
        "CONFIG_INVALID",
        `${name} must be from ${low} to ${high}.`,
      );
  };
  range(options.strength, "strength", 0, 1);
  range(options.targetLufs, "targetLufs", -70, -5);
  range(options.truePeakDbtp, "truePeakDbtp", -9, 0);
  range(options.loudnessRangeLu, "loudnessRangeLu", 1, 50);
  integer(
    options.maxTempBytes ?? 4_294_967_296,
    "maxTempBytes",
    1024,
    Number.MAX_SAFE_INTEGER,
  );
  integer(options.memoryBudgetMiB ?? 512, "memoryBudgetMiB", 32, 65536);
  if (options.sampleRate !== undefined)
    integer(options.sampleRate, "sampleRate", 8000, 192000);
  if (options.channels !== undefined)
    integer(options.channels, "channels", 1, 8);
  if (options.bitrateKbps !== undefined)
    integer(options.bitrateKbps, "bitrateKbps", 16, 320);
  if (options.bitDepth !== undefined && ![16, 24].includes(options.bitDepth))
    throw new AuditError("CONFIG_INVALID", "bitDepth must be 16 or 24.");
  if (
    options.format !== undefined &&
    !["wav", "flac", "mp3", "opus"].includes(options.format)
  )
    throw new AuditError("CONFIG_INVALID", "Unsupported output format.");
  for (const key of ["normalize", "voiceProcessing", "overwrite"] as const)
    if (options[key] !== undefined && typeof options[key] !== "boolean")
      throw new AuditError("CONFIG_INVALID", `${key} must be boolean.`);
  for (const key of ["tempDirectory", "modelDir"] as const)
    if (
      options[key] !== undefined &&
      (typeof options[key] !== "string" ||
        !options[key]!.length ||
        options[key]!.includes("\0"))
    )
      throw new AuditError(
        "CONFIG_INVALID",
        `${key} must be a local directory.`,
      );
}
async function destinationFor(
  input: string,
  destination: string,
  overwrite: boolean,
): Promise<string> {
  if (
    typeof destination !== "string" ||
    !destination.length ||
    destination.includes("\0") ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(destination)
  )
    throw new AuditError("OUTPUT_INVALID", "Provide a local output file path.");
  const parent = await realpath(dirname(resolve(destination))).catch((e) => {
    throw new AuditError(
      "OUTPUT_DIRECTORY",
      "The output directory does not exist.",
      { cause: e },
    );
  });
  const path = join(parent, basename(destination));
  if (path === input)
    throw new AuditError(
      "OUTPUT_CLOBBER",
      "Output must not replace the source recording.",
    );
  const existing = await lstat(path).catch((e) => {
    if (e.code !== "ENOENT") throw e;
    return null;
  });
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink())
      throw new AuditError(
        "OUTPUT_INVALID",
        "Output must be a regular file destination.",
      );
    const source = await stat(input);
    if (existing.dev === source.dev && existing.ino === source.ino)
      throw new AuditError(
        "OUTPUT_CLOBBER",
        "Output must not replace the source recording.",
      );
    if (!overwrite)
      throw new AuditError(
        "OUTPUT_EXISTS",
        "Output exists; enable overwrite deliberately.",
      );
  }
  return path;
}
function codec(format: OutputFormat, options: ProcessingOptions): string[] {
  switch (format) {
    case "wav":
      return [
        "-c:a",
        options.bitDepth === 24 ? "pcm_s24le" : "pcm_s16le",
        "-f",
        "wav",
        "-rf64",
        "auto",
      ];
    case "flac":
      return [
        "-c:a",
        "flac",
        "-sample_fmt",
        options.bitDepth === 24 ? "s32" : "s16",
        "-f",
        "flac",
      ];
    case "mp3":
      return [
        "-c:a",
        "libmp3lame",
        "-b:a",
        `${options.bitrateKbps ?? 192}k`,
        "-f",
        "mp3",
      ];
    case "opus":
      return [
        "-c:a",
        "libopus",
        "-b:a",
        `${options.bitrateKbps ?? 128}k`,
        "-f",
        "opus",
      ];
  }
}

/** Local full-file processing; publication occurs only after decode validation and cleanup. */
export async function processAudio(
  file: string,
  destination: string,
  mode: ProcessingMode,
  supplied: ProcessingOptions = {},
): Promise<ProcessingResult> {
  processingLimits(supplied);
  if (!["denoise", "enhance", "normalize", "convert"].includes(mode))
    throw new AuditError("CONFIG_INVALID", "Unsupported processing mode.");
  const signal = AbortSignal.any([
    ...(supplied.signal ? [supplied.signal] : []),
    AbortSignal.timeout(supplied.timeoutMs ?? 3_600_000),
  ]);
  const options = {
    ...supplied,
    memoryBudgetMiB: supplied.memoryBudgetMiB ?? 512,
    signal,
  };
  aborted(signal);
  const started = performance.now();
  const source = await localFile(file, options);
  const target = await destinationFor(
    source.path,
    destination,
    options.overwrite ?? false,
  );
  const format =
    options.format ?? (extname(target).slice(1).toLowerCase() as OutputFormat);
  if (!["wav", "flac", "mp3", "opus"].includes(format))
    throw new AuditError(
      "CONFIG_INVALID",
      "Specify WAV, FLAC, MP3 or Opus output.",
    );
  const input = await inspect(source.path, options);
  const channels = options.channels ?? input.selectedStream.channels;
  const sampleRate =
    format === "opus"
      ? 48000
      : (options.sampleRate ?? input.selectedStream.sampleRate);
  if (
    format === "opus" &&
    options.sampleRate !== undefined &&
    options.sampleRate !== 48000
  )
    throw new AuditError(
      "CONFIG_INVALID",
      "Opus exports use a 48000 Hz playback clock.",
    );
  if ((format === "mp3" || format === "opus") && channels > 2)
    throw new AuditError(
      "CONFIG_INVALID",
      "MP3 and Opus exports require mono or stereo; select channels explicitly.",
    );
  if (
    format === "mp3" &&
    ![8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000].includes(
      sampleRate,
    )
  )
    throw new AuditError(
      "CONFIG_INVALID",
      "Choose a supported MP3 sample rate explicitly.",
    );
  const neural = mode === "denoise" || mode === "enhance";
  const workingRate = neural ? 48000 : sampleRate;
  const strength = neural ? (options.strength ?? 1) : 0;
  const normalized =
    mode === "normalize" || (options.normalize ?? mode === "enhance");
  const voiceProcessing =
    mode === "enhance" && (options.voiceProcessing ?? true);
  const targetLufs = options.targetLufs ?? -16,
    truePeak = options.truePeakDbtp ?? -1.5;
  const maxTemp = options.maxTempBytes ?? 4_294_967_296;
  const scratch = await mkdtemp(
    join(resolve(options.tempDirectory ?? tmpdir()), "loudness-audio-"),
  );
  const rawPath = join(scratch, "clean.f32");
  // Same-filesystem staging permits atomic final publication without a copy.
  const staged = join(dirname(target), `.loudness-audio-${randomUUID()}.tmp`);
  const stageHandle = await open(staged, "wx", 0o600).catch(async (e) => {
    await rm(scratch, { recursive: true, force: true });
    throw e;
  });
  await stageHandle.close();
  let workerResult:
    | {
        frames: number;
        sampleRate: number;
        channels: number;
        initializedMs: number;
        wallMs: number;
      }
    | undefined;
  let workerError: { code: string; message: string } | undefined;
  const measurements: ProcessMetrics[] = [];
  const warnings: string[] = [];
  const runOptions = {
    signal,
    measure: true,
    maxRssBytes: (options.memoryBudgetMiB ?? 512) * 1048576,
  };
  try {
    const configuration = {
      input: source.path,
      output: rawPath,
      ffmpeg: options.ffmpegPath ?? "ffmpeg",
      streamIndex: input.selectedStream.index,
      modelDir: resolve(
        options.modelDir ?? join(__dirname, "../../models/dfn3-512-v1"),
      ),
      channels,
      sampleRate: workingRate,
      threads: options.nativeThreads ?? 1,
      maxDuration: options.maxDurationSeconds ?? 86400,
      maxTempBytes: maxTemp,
      declaredDuration: input.declaredDurationSeconds,
      neural,
      strength,
    };
    const worker = await run(
      process.execPath,
      [join(__dirname, "processing-worker.js"), JSON.stringify(configuration)],
      {
        ...runOptions,
        maxStdoutBytes: 24 * 1024 * 1024,
        onChunk: () => {},
        onStdoutLine: (line) => {
          let value;
          try {
            value = JSON.parse(line);
          } catch {
            return;
          }
          if (value.kind === "worker-result") workerResult = value;
          else if (value.kind === "worker-error") workerError = value;
          else if (["initialize", "denoise", "decode"].includes(value.phase))
            notify(options, value);
        },
      },
    ).catch((e) => {
      if (workerError && e instanceof AuditError && e.code === "PROCESS_FAILED")
        throw new AuditError(workerError.code, workerError.message);
      throw e;
    });
    measurements.push(worker.metrics);
    if (
      !workerResult ||
      !Number.isSafeInteger(workerResult.frames) ||
      workerResult.frames <= 0
    )
      throw new AuditError(
        "OUTPUT_INVALID",
        "The speech processor did not return a complete recording.",
      );
    const duration = workerResult.frames / workingRate;
    const rawBytes = (await stat(rawPath)).size;
    const expectedBytes = workerResult.frames * channels * 4;
    if (rawBytes !== expectedBytes || rawBytes >= maxTemp)
      throw new AuditError(
        "TEMP_LIMIT",
        "The temporary-disk budget cannot fit this recording and its export.",
      );
    const sourceLayout =
      options.channels === undefined
        ? input.selectedStream.channelLayout
        : null;
    const rawArgs = [
      "-f",
      "f32le",
      "-ar",
      String(workingRate),
      "-ac",
      String(channels),
      ...(sourceLayout ? ["-channel_layout", sourceLayout] : []),
      "-i",
      rawPath,
    ];
    const filters: string[] = voiceProcessing
      ? [
          "highpass=f=80",
          "acompressor=threshold=0.125:ratio=2:attack=10:release=150:makeup=1",
        ]
      : [];
    if (normalized) {
      notify(options, { phase: "normalize", fraction: null });
      const pass = await run(
        options.ffmpegPath ?? "ffmpeg",
        [
          "-nostdin",
          "-v",
          "info",
          "-threads",
          String(options.nativeThreads ?? 1),
          ...rawArgs,
          "-af",
          [
            ...filters,
            `loudnorm=I=${targetLufs}:TP=${truePeak}:LRA=${options.loudnessRangeLu ?? 11}:print_format=json`,
          ].join(","),
          "-f",
          "null",
          "-",
        ],
        runOptions,
      );
      measurements.push(pass.metrics);
      const block = pass.stderr.match(/\{\s*"input_i"[\s\S]*?\}/)?.[0];
      if (!block)
        throw new AuditError(
          "NORMALIZATION_FAILED",
          "Could not measure audio for normalization.",
        );
      const measured = JSON.parse(block);
      const keys = [
        "input_i",
        "input_tp",
        "input_lra",
        "input_thresh",
        "target_offset",
      ];
      if (keys.some((key) => !Number.isFinite(Number(measured[key]))))
        warnings.push(
          "Loudness normalization was skipped because the recording has no measurable gated loudness.",
        );
      else
        filters.push(
          `loudnorm=I=${targetLufs}:TP=${truePeak}:LRA=${options.loudnessRangeLu ?? 11}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`,
        );
    }
    notify(options, { phase: "export", fraction: 0 });
    const exported = await run(
      options.ffmpegPath ?? "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-threads",
        String(options.nativeThreads ?? 1),
        ...rawArgs,
        ...(filters.length ? ["-af", filters.join(",")] : []),
        "-map_metadata",
        "-1",
        "-ar",
        String(sampleRate),
        "-ac",
        String(channels),
        ...codec(format, options),
        "-progress",
        "pipe:1",
        staged,
      ],
      {
        ...runOptions,
        onChunk: () => {},
        onStdoutLine: (line) => {
          const [key, value] = line.split("=");
          if (key === "total_size" && Number(value) + rawBytes > maxTemp)
            throw new AuditError(
              "TEMP_LIMIT",
              "The audio export exceeds the configured temporary-disk budget.",
            );
          if (key === "out_time_us")
            notify(options, {
              phase: "export",
              fraction: Math.min(0.99, Number(value) / 1e6 / duration),
            });
        },
      },
    );
    measurements.push(exported.metrics);
    const outputBytes = (await stat(staged)).size;
    if (!outputBytes || outputBytes + rawBytes > maxTemp)
      throw new AuditError(
        "TEMP_LIMIT",
        "The audio export exceeds the temporary-disk budget.",
      );
    notify(options, { phase: "verify", fraction: null });
    const analysis = await analyze(staged, {
      ...options,
      streamIndex: undefined,
      maxFileBytes: Math.max(
        outputBytes,
        options.maxFileBytes ?? 10_737_418_240,
      ),
      onProgress: undefined,
    });
    const outputStream = analysis.input.selectedStream;
    if (
      outputStream.channels !== channels ||
      outputStream.sampleRate !== sampleRate ||
      Math.abs(analysis.durationSeconds - duration) >
        (format === "mp3" ? 0.06 : 2 / sampleRate)
    )
      throw new AuditError(
        "OUTPUT_INVALID",
        "The exported audio has unexpected timing, rate or channels.",
      );
    if (
      normalized &&
      analysis.integratedLufs !== null &&
      Math.abs(analysis.integratedLufs - targetLufs) > 0.5
    )
      warnings.push(
        "The measured output did not reach the requested loudness within 0.5 LU.",
      );
    if (
      normalized &&
      analysis.truePeakDbtp !== null &&
      analysis.truePeakDbtp > truePeak + 0.2
    )
      warnings.push(
        "The decoded output exceeds the requested true-peak target; choose lossless export or a lower target.",
      );
    if ((await localFile(source.path, options)).signature !== source.signature)
      throw new AuditError(
        "INPUT_CHANGED",
        "The source recording changed during processing.",
      );
    aborted(signal);
    // Windows FlushFileBuffers requires write access; r+ preserves the staged bytes.
    const sync = await open(staged, "r+");
    try {
      await sync.sync();
    } finally {
      await sync.close();
    }
    await rm(scratch, { recursive: true, force: true });
    // Recheck aliases immediately before the atomic publication step.
    await destinationFor(source.path, target, options.overwrite ?? false);
    aborted(signal);
    if (options.overwrite) await rename(staged, target);
    else {
      await link(staged, target).catch((e) => {
        if (e.code === "EEXIST")
          throw new AuditError(
            "OUTPUT_EXISTS",
            "The output destination was created by another job.",
          );
        throw e;
      });
      await unlink(staged);
    }
    analysis.input.file.name = basename(target);
    const peaks = measurements
      .map((m) => m.sampledPeakTreeRssBytes)
      .filter((n): n is number => n !== null);
    const result: ProcessingResult = {
      schemaVersion: 1,
      kind: "processing",
      mode,
      input,
      output: {
        path: target,
        name: basename(target),
        sizeBytes: outputBytes,
        format,
        sampleRate,
        channels,
        durationSeconds: analysis.durationSeconds,
      },
      settings: {
        strength,
        voiceProcessing,
        normalized:
          normalized &&
          warnings.every(
            (w) => !w.startsWith("Loudness normalization was skipped"),
          ),
        targetLufs: normalized ? targetLufs : null,
        truePeakDbtp: normalized ? truePeak : null,
      },
      analysis,
      warnings,
      metrics: {
        wallMs: performance.now() - started,
        initializedMs: workerResult.initializedMs,
        inferenceWallMs: workerResult.wallMs,
        sampledPeakTreeRssBytes: peaks.length ? Math.max(...peaks) : null,
        samplingIntervalMs: 100,
        temporaryAudioBytes: rawBytes + outputBytes,
        memoryMethod: peaks.length
          ? "sampled-process-group-rss"
          : "unavailable",
      },
    };
    notify(options, { phase: "complete", fraction: 1 });
    return result;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOSPC")
      throw new AuditError(
        "OUTPUT_SPACE",
        "There is insufficient disk space for processing.",
        { cause: e },
      );
    if (["EACCES", "EPERM"].includes(code ?? ""))
      throw new AuditError(
        "OUTPUT_PERMISSION",
        "Could not write the processed audio destination.",
        { cause: e },
      );
    throw e;
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await unlink(staged).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}
export const denoise = (
  file: string,
  output: string,
  options: ProcessingOptions = {},
) => processAudio(file, output, "denoise", options);
export const enhance = (
  file: string,
  output: string,
  options: ProcessingOptions = {},
) => processAudio(file, output, "enhance", options);
export const normalize = (
  file: string,
  output: string,
  options: ProcessingOptions = {},
) => processAudio(file, output, "normalize", options);
export const convert = (
  file: string,
  output: string,
  options: ProcessingOptions = {},
) => processAudio(file, output, "convert", options);
