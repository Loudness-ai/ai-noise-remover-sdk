import { stat, realpath, access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, basename } from "node:path";
import { AuditError, aborted, positive, integer, observe } from "./errors.js";
import { run } from "./process.js";
import type { Inspection, Options, AudioStream, Progress } from "./types.js";
// Only self-contained media demuxers. Playlists/concat inputs can reference other local files.
export const mediaFormats = "wav,mp3,flac,mov,aac,ogg,matroska,webm,aiff";
export function notify(options: Options, event: Progress): void {
  observe(() => options.onProgress?.(event));
}
export function limits(options: Options): void {
  if (options.memoryBudgetMiB !== undefined)
    integer(options.memoryBudgetMiB, "memoryBudgetMiB", 32, 65536);
  integer(options.timeoutMs ?? 3_600_000, "timeoutMs", 1, 2_147_483_647);
  integer(
    options.maxFileBytes ?? 10_737_418_240,
    "maxFileBytes",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  positive(options.maxDurationSeconds ?? 86400, "maxDurationSeconds", 604800);
  integer(options.nativeThreads ?? 1, "nativeThreads", 1, 256);
  integer(options.maxPoints ?? 2048, "maxPoints", 16, 16384);
  integer(options.maxEvents ?? 128, "maxEvents", 0, 10000);
  if (options.streamIndex !== undefined)
    integer(options.streamIndex, "streamIndex", 0, 100000);
  const silence = options.silenceThresholdDbfs ?? -60;
  if (!Number.isFinite(silence) || silence < -180 || silence > 0)
    throw new AuditError(
      "CONFIG_INVALID",
      "silenceThresholdDbfs must be from -180 to 0.",
    );
  positive(options.minSilenceSeconds ?? 0.2, "minSilenceSeconds", 86400);
  positive(options.clippingThreshold ?? 0.999, "clippingThreshold", 2);
  positive(options.discontinuityThreshold ?? 0.8, "discontinuityThreshold", 4);
  for (const path of [options.ffmpegPath, options.ffprobePath])
    if (
      path !== undefined &&
      (typeof path !== "string" || !path.length || path.includes("\0"))
    )
      throw new AuditError(
        "CONFIG_INVALID",
        "Executable paths must be nonempty strings.",
      );
}
export async function localFile(
  file: string,
  options: Options = {},
): Promise<{ path: string; size: number; signature: string }> {
  aborted(options.signal);
  limits(options);
  if (
    typeof file !== "string" ||
    !file.length ||
    file.includes("\0") ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(file)
  )
    throw new AuditError("INPUT_INVALID", "Provide a local audio file path.");
  let path: string;
  let info;
  try {
    path = await realpath(resolve(file));
    info = await stat(path, { bigint: true });
    if (info.isFile()) await access(path, constants.R_OK);
  } catch (e) {
    throw new AuditError("INPUT_UNREADABLE", "Could not read the input file.", {
      cause: e,
    });
  }
  if (!info.isFile() || info.size === 0n)
    throw new AuditError(
      "INPUT_INVALID",
      "The input must be a nonempty regular file.",
    );
  if (info.size > (options.maxFileBytes ?? 10_737_418_240))
    throw new AuditError(
      "FILE_LIMIT",
      "The file exceeds the configured byte limit.",
    );
  return {
    path,
    size: Number(info.size),
    signature: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(
      ":",
    ),
  };
}
function duration(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
export async function inspect(
  file: string,
  options: Options = {},
): Promise<Inspection> {
  const input = await localFile(file, options);
  notify(options, { phase: "inspect", fraction: null });
  const result = await run(
    options.ffprobePath ?? "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-format_whitelist",
      mediaFormats,
      "-show_entries",
      "stream=index,codec_type,codec_name,sample_rate,channels,channel_layout,duration:stream_tags=language:format=format_name,duration",
      "-of",
      "json",
      input.path,
    ],
    {
      signal: options.signal,
      timeoutMs: Math.min(options.timeoutMs ?? 30000, 30000),
      maxRssBytes: options.memoryBudgetMiB
        ? options.memoryBudgetMiB * 1048576
        : undefined,
    },
  ).catch((e) => {
    if (e instanceof AuditError && e.code === "PROCESS_FAILED")
      throw new AuditError(
        "MEDIA_INVALID",
        "The input is not readable media or its header is damaged.",
        { cause: e },
      );
    throw e;
  });
  let raw: {
    streams?: {
      index: number;
      codec_type: string;
      codec_name: string;
      sample_rate: string;
      channels: number;
      channel_layout?: string;
      duration?: string;
      tags?: { language?: string };
    }[];
    format?: { duration?: string; format_name?: string };
  };
  try {
    raw = JSON.parse(result.stdout.toString());
  } catch {
    throw new AuditError(
      "PROBE_INVALID",
      "The media inspection report was invalid.",
    );
  }
  const streams: AudioStream[] = (raw.streams ?? [])
    .filter((s) => s.codec_type === "audio")
    .map((s) => ({
      index: s.index,
      codec: s.codec_name,
      sampleRate: Number(s.sample_rate),
      channels: s.channels,
      channelLayout: s.channel_layout ?? null,
      declaredDurationSeconds: duration(s.duration),
      language: s.tags?.language ?? null,
    }));
  if (streams.length > 64)
    throw new AuditError(
      "AUDIO_UNSUPPORTED",
      "Analysis supports at most 64 selectable audio tracks in a file.",
    );
  if (!streams.length)
    throw new AuditError(
      "NO_AUDIO",
      "The file contains no readable audio stream.",
    );
  if (streams.length > 1 && options.streamIndex === undefined)
    throw new AuditError(
      "STREAM_REQUIRED",
      "The file has multiple audio streams; choose streamIndex explicitly.",
    );
  const selectedStream =
    options.streamIndex === undefined
      ? streams[0]
      : streams.find((s) => s.index === options.streamIndex);
  if (!selectedStream)
    throw new AuditError(
      "STREAM_INVALID",
      "The selected audio stream does not exist.",
    );
  if (
    typeof selectedStream.codec !== "string" ||
    selectedStream.codec === "unknown"
  )
    throw new AuditError(
      "CODEC_UNSUPPORTED",
      "The selected stream's audio codec is unsupported.",
    );
  if (
    !Number.isInteger(selectedStream.channels) ||
    selectedStream.channels < 1 ||
    selectedStream.channels > 8 ||
    !Number.isInteger(selectedStream.sampleRate) ||
    selectedStream.sampleRate < 8000 ||
    selectedStream.sampleRate > 192000
  )
    throw new AuditError(
      "AUDIO_UNSUPPORTED",
      "Supported analysis inputs have 1–8 channels and a sample rate from 8–192 kHz.",
    );
  const declared =
    selectedStream.declaredDurationSeconds ?? duration(raw.format?.duration);
  if (
    declared !== null &&
    declared > (options.maxDurationSeconds ?? 86400) + 0.05
  )
    throw new AuditError(
      "DURATION_LIMIT",
      "The recording exceeds the configured duration limit.",
    );
  return {
    schemaVersion: 1,
    kind: "inspection",
    file: {
      name: basename(input.path),
      sizeBytes: input.size,
      container: raw.format?.format_name ?? "unknown",
    },
    streams,
    selectedStream,
    declaredDurationSeconds: declared,
  };
}
export async function doctor(options: Options = {}): Promise<{
  ready: boolean;
  versions: Record<string, string>;
  errors: string[];
}> {
  limits(options);
  const versions: Record<string, string> = {};
  const errors: string[] = [];
  for (const [name, executable] of [
    ["ffmpeg", options.ffmpegPath ?? "ffmpeg"],
    ["ffprobe", options.ffprobePath ?? "ffprobe"],
  ]) {
    try {
      const r = await run(executable, ["-version"], {
        signal: options.signal,
        timeoutMs: Math.min(options.timeoutMs ?? 10000, 10000),
      });
      versions[name] = r.stdout.toString().split("\n")[0];
    } catch (e) {
      aborted(options.signal);
      errors.push(
        `${name}: ${e instanceof AuditError ? e.code : "UNAVAILABLE"}`,
      );
    }
  }
  if (versions.ffmpeg) {
    const r = await run(
      options.ffmpegPath ?? "ffmpeg",
      ["-hide_banner", "-filters"],
      { signal: options.signal, timeoutMs: 10000 },
    );
    if (!/\bebur128\b/.test(r.stdout.toString()))
      errors.push("Required loudness filter is unavailable.");
  }
  return { ready: errors.length === 0, versions, errors };
}
