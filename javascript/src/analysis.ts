import { createHash } from "node:crypto";
import { AuditError, aborted, positive } from "./errors.js";
import { inspect, localFile, notify, limits, mediaFormats } from "./input.js";
import { run } from "./process.js";
import type {
  Analysis,
  Options,
  WavePoint,
  Interval,
  LoudnessPoint,
  ChannelMeasurement,
} from "./types.js";

export function db(amplitude: number): number | null {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : null;
}
function powerDb(power: number): number | null {
  return db(Math.sqrt(Math.max(0, power)));
}
function finiteReading(value: string): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function mergeWave(a: WavePoint, b: WavePoint): WavePoint {
  const da = a.endSeconds - a.startSeconds;
  const db = b.endSeconds - b.startSeconds;
  return {
    startSeconds: a.startSeconds,
    endSeconds: b.endSeconds,
    min: Math.min(a.min, b.min),
    max: Math.max(a.max, b.max),
    rms: Math.sqrt((a.rms ** 2 * da + b.rms ** 2 * db) / (da + db)),
  };
}
/** Statistics are accumulated once per decoded frame, independent of pipe boundaries. */
export class Scanner {
  frames = 0;
  private remainder = Buffer.alloc(0);
  private hash = createHash("sha256");
  private peak: number[];
  private squares: number[];
  private sum: number[];
  private clips: number[];
  private run: number[];
  private longest: number[];
  private previous: number[];
  private cross = 0;
  private low: number[];
  private mid: number[];
  private bands = [0, 0, 0];
  waveform: WavePoint[] = [];
  private waveStart = 0;
  private waveN = 0;
  private waveMin = Infinity;
  private waveMax = -Infinity;
  private wavePower = 0;
  private waveFrames: number;
  silenceIntervals: Interval[] = [];
  silenceCount = 0;
  totalSilence = 0;
  leading = 0;
  trailing = 0;
  private quietStart: number | null = null;
  private windowN = 0;
  private windowPower = 0;
  discontinuities: { timeSeconds: number; channel: number }[] = [];
  discontinuityCount = 0;
  readonly threshold: number;
  readonly minSilence: number;
  readonly clipThreshold: number;
  readonly jump: number;
  constructor(
    readonly sampleRate: number,
    readonly channelCount: number,
    readonly options: Options = {},
  ) {
    this.peak = Array(channelCount).fill(0);
    this.squares = Array(channelCount).fill(0);
    this.sum = Array(channelCount).fill(0);
    this.clips = Array(channelCount).fill(0);
    this.run = Array(channelCount).fill(0);
    this.longest = Array(channelCount).fill(0);
    this.previous = Array(channelCount).fill(0);
    this.low = Array(channelCount).fill(0);
    this.mid = Array(channelCount).fill(0);
    this.waveFrames = Math.max(1, Math.round(sampleRate / 10));
    this.threshold = options.silenceThresholdDbfs ?? -60;
    if (
      !Number.isFinite(this.threshold) ||
      this.threshold > 0 ||
      this.threshold < -180
    )
      throw new AuditError(
        "CONFIG_INVALID",
        "silenceThresholdDbfs must be from -180 to 0.",
      );
    this.minSilence = positive(
      options.minSilenceSeconds ?? 0.2,
      "minSilenceSeconds",
      86400,
    );
    this.clipThreshold = positive(
      options.clippingThreshold ?? 0.999,
      "clippingThreshold",
      2,
    );
    this.jump = positive(
      options.discontinuityThreshold ?? 0.8,
      "discontinuityThreshold",
      4,
    );
  }
  consume(chunk: Buffer): void {
    aborted(this.options.signal);
    const bytesPerFrame = this.channelCount * 8;
    const data = this.remainder.length
      ? Buffer.concat([this.remainder, chunk])
      : chunk;
    const usable = data.length - (data.length % bytesPerFrame);
    this.remainder = Buffer.from(data.subarray(usable));
    this.hash.update(data.subarray(0, usable));
    const alphaLow = 1 - Math.exp((-2 * Math.PI * 200) / this.sampleRate);
    const alphaMid = 1 - Math.exp((-2 * Math.PI * 2000) / this.sampleRate);
    const maxFrames =
      (this.options.maxDurationSeconds ?? 86400) * this.sampleRate;
    for (let at = 0; at < usable; at += bytesPerFrame) {
      let framePower = 0;
      let first = 0;
      for (let c = 0; c < this.channelCount; c++) {
        const v = data.readDoubleLE(at + c * 8);
        if (!Number.isFinite(v) || Math.abs(v) > 1e100)
          throw new AuditError(
            "PCM_INVALID",
            "Decoded audio contains invalid or numerically unsafe samples.",
          );
        const abs = Math.abs(v);
        const sq = v * v;
        this.peak[c] = Math.max(this.peak[c], abs);
        this.squares[c] += sq;
        this.sum[c] += v;
        framePower += sq;
        if (abs >= this.clipThreshold) {
          this.clips[c]++;
          this.run[c]++;
          this.longest[c] = Math.max(this.longest[c], this.run[c]);
        } else this.run[c] = 0;
        if (this.frames && Math.abs(v - this.previous[c]) >= this.jump) {
          this.discontinuityCount++;
          if (this.discontinuities.length < (this.options.maxEvents ?? 128))
            this.discontinuities.push({
              timeSeconds: this.frames / this.sampleRate,
              channel: c,
            });
        }
        this.previous[c] = v;
        if (c === 0) first = v;
        else if (c === 1) this.cross += first * v;
        this.low[c] += alphaLow * (v - this.low[c]);
        this.mid[c] += alphaMid * (v - this.mid[c]);
        this.bands[0] += this.low[c] ** 2;
        this.bands[1] += (this.mid[c] - this.low[c]) ** 2;
        this.bands[2] += (v - this.mid[c]) ** 2;
        this.waveMin = Math.min(this.waveMin, v);
        this.waveMax = Math.max(this.waveMax, v);
      }
      this.frames++;
      if (this.frames > maxFrames)
        throw new AuditError(
          "DURATION_LIMIT",
          "Decoded audio exceeds the duration limit.",
        );
      framePower /= this.channelCount;
      this.wavePower += framePower;
      this.waveN++;
      this.windowPower += framePower;
      this.windowN++;
      if (this.waveN >= this.waveFrames) this.flushWave();
      if (this.windowN >= Math.round(this.sampleRate / 10)) this.flushQuiet();
    }
  }
  private flushWave(): void {
    if (!this.waveN) return;
    this.waveform.push({
      startSeconds: this.waveStart / this.sampleRate,
      endSeconds: this.frames / this.sampleRate,
      min: this.waveMin,
      max: this.waveMax,
      rms: Math.sqrt(this.wavePower / this.waveN),
    });
    this.waveStart = this.frames;
    this.waveN = 0;
    this.wavePower = 0;
    this.waveMin = Infinity;
    this.waveMax = -Infinity;
    if (this.waveform.length > (this.options.maxPoints ?? 2048)) {
      const merged: WavePoint[] = [];
      for (let i = 0; i < this.waveform.length; i += 2)
        merged.push(
          this.waveform[i + 1]
            ? mergeWave(this.waveform[i], this.waveform[i + 1])
            : this.waveform[i],
        );
      this.waveform = merged;
      this.waveFrames *= 2;
    }
  }
  private flushQuiet(): void {
    if (!this.windowN) return;
    const start = (this.frames - this.windowN) / this.sampleRate;
    const isQuiet =
      this.windowPower / this.windowN <= 10 ** (this.threshold / 10);
    if (isQuiet) this.quietStart ??= start;
    else this.endQuiet(start);
    this.windowN = 0;
    this.windowPower = 0;
  }
  private endQuiet(end: number): void {
    if (this.quietStart !== null) {
      const duration = end - this.quietStart;
      if (duration + 1e-9 >= this.minSilence) {
        this.totalSilence += duration;
        this.silenceCount++;
        if (this.quietStart === 0) this.leading = duration;
        if (Math.abs(end - this.frames / this.sampleRate) < 1e-9)
          this.trailing = duration;
        if (this.silenceIntervals.length < (this.options.maxEvents ?? 128))
          this.silenceIntervals.push({
            startSeconds: this.quietStart,
            endSeconds: end,
          });
      }
    }
    this.quietStart = null;
  }
  finish(): {
    channels: ChannelMeasurement[];
    samplePeakDbfs: number | null;
    rmsDbfs: number | null;
    pcmHash: string;
    correlation: number | null;
    imbalance: number | null;
    bands: [number | null, number | null, number | null];
  } {
    if (this.remainder.length)
      throw new AuditError(
        "PCM_TRUNCATED",
        "The decoded audio ended inside a sample frame.",
      );
    if (!this.frames)
      throw new AuditError(
        "NO_SAMPLES",
        "The recording has no decoded samples.",
      );
    this.flushWave();
    this.flushQuiet();
    this.endQuiet(this.frames / this.sampleRate);
    const channels = this.peak.map((peak, c) => {
      const rms = powerDb(this.squares[c] / this.frames);
      const p = db(peak);
      return {
        samplePeakDbfs: p,
        rmsDbfs: rms,
        crestFactorDb: p === null || rms === null ? null : p - rms,
        dcOffset: this.sum[c] / this.frames,
        nearFullScaleSamples: this.clips[c],
        longestNearFullScaleRun: this.longest[c],
      };
    });
    const variance0 = this.squares[0] - this.sum[0] ** 2 / this.frames;
    const variance1 =
      this.channelCount === 2
        ? this.squares[1] - this.sum[1] ** 2 / this.frames
        : 0;
    const correlation =
      this.channelCount === 2 && variance0 > 1e-20 && variance1 > 1e-20
        ? Math.max(
            -1,
            Math.min(
              1,
              (this.cross - (this.sum[0] * this.sum[1]) / this.frames) /
                Math.sqrt(variance0 * variance1),
            ),
          )
        : null;
    const imbalance =
      this.channelCount === 2 &&
      channels[0].rmsDbfs !== null &&
      channels[1].rmsDbfs !== null
        ? channels[0].rmsDbfs! - channels[1].rmsDbfs!
        : null;
    return {
      channels,
      samplePeakDbfs: db(Math.max(...this.peak)),
      rmsDbfs: powerDb(
        this.squares.reduce((a, b) => a + b, 0) /
          this.frames /
          this.channelCount,
      ),
      pcmHash: this.hash.digest("hex"),
      correlation,
      imbalance,
      bands: this.bands.map((v) =>
        powerDb(v / this.frames / this.channelCount),
      ) as [number | null, number | null, number | null],
    };
  }
}
export async function analyze(
  file: string,
  options: Options = {},
): Promise<Analysis> {
  limits(options);
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(options.timeoutMs ?? 3_600_000),
  ]);
  options = { ...options, signal };
  const source = await localFile(file, options);
  const input = await inspect(source.path, options);
  const stream = input.selectedStream;
  const scanner = new Scanner(stream.sampleRate, stream.channels, options);
  let timeline: LoudnessPoint[] = [];
  let stride = 1;
  let frames = 0;
  let eligible = false;
  let lastProgress = 0;
  let corruptMedia = false;
  const r = await run(
    options.ffmpegPath ?? "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-nostats",
      "-loglevel",
      "verbose",
      "-xerror",
      "-threads",
      String(options.nativeThreads ?? 1),
      "-filter_threads",
      "1",
      "-protocol_whitelist",
      "file,pipe",
      "-format_whitelist",
      mediaFormats,
      "-i",
      source.path,
      "-map",
      `0:${stream.index}`,
      "-vn",
      "-sn",
      "-dn",
      "-af",
      `aformat=sample_fmts=dbl:sample_rates=${stream.sampleRate},ebur128=peak=true:framelog=verbose,aformat=sample_fmts=dbl:sample_rates=${stream.sampleRate}`,
      "-c:a",
      "pcm_f64le",
      "-f",
      "f64le",
      "pipe:1",
    ],
    {
      signal,
      timeoutMs: options.timeoutMs,
      maxRssBytes: options.memoryBudgetMiB
        ? options.memoryBudgetMiB * 1048576
        : undefined,
      onChunk(chunk) {
        scanner.consume(chunk);
        const now = Date.now();
        if (now - lastProgress > 200) {
          lastProgress = now;
          const decodedSeconds = scanner.frames / stream.sampleRate;
          notify(options, {
            phase: "decode",
            decodedSeconds,
            fraction: input.declaredDurationSeconds
              ? Math.min(0.99, decodedSeconds / input.declaredDurationSeconds)
              : null,
          });
        }
      },
      onLine(line) {
        if (
          /Packet corrupt|corrupt input packet|Invalid data found/i.test(line)
        )
          corruptMedia = true;
        const match = line.match(
          /\bt:\s*([\d.]+).*?\bM:\s*(-?[\d.]+).*?\bS:\s*(-?[\d.]+)/,
        );
        if (!match) return;
        const t = Number(match[1]) + 1 / stream.sampleRate;
        const m = Number(match[2]);
        const s = Number(match[3]);
        if (t >= 0.4 - 1e-5 && m >= -70) eligible = true;
        frames++;
        if ((frames - 1) % stride === 0)
          timeline.push({
            timeSeconds: t,
            momentaryLufs: t >= 0.4 - 1e-5 && m > -120 ? m : null,
            shortTermLufs: t >= 3 - 1e-5 && s > -120 ? s : null,
          });
        if (timeline.length > (options.maxPoints ?? 2048)) {
          timeline = timeline.filter((_, i) => i % 2 === 0);
          stride *= 2;
        }
      },
    },
  ).catch((e) => {
    if (e instanceof AuditError && e.code === "PROCESS_FAILED")
      throw new AuditError(
        "DECODE_FAILED",
        "The selected audio stream could not be decoded completely.",
        { cause: e },
      );
    throw e;
  });
  aborted(signal);
  if ((await localFile(source.path, options)).signature !== source.signature)
    throw new AuditError(
      "INPUT_CHANGED",
      "The source file changed during measurement.",
    );
  if (corruptMedia)
    throw new AuditError(
      "DECODE_INVALID",
      "The decoder reported corrupt or truncated media.",
    );
  const stats = scanner.finish();
  const summary = r.stderr.slice(r.stderr.lastIndexOf("Summary:"));
  const integrated = summary.match(/\bI:\s*(-?[\d.]+|[-+]?inf)\s+LUFS/);
  const range = summary.match(/\bLRA:\s*(-?[\d.]+)\s+LU/);
  const tp = summary.match(/True peak:\s*Peak:\s*(-?[\d.]+|[-+]?inf)\s+dBFS/);
  if (!integrated || !range || !tp)
    throw new AuditError(
      "MEASUREMENT_INVALID",
      "The loudness summary was incomplete.",
    );
  const durationSeconds = scanner.frames / stream.sampleRate;
  const state =
    stats.samplePeakDbfs === null
      ? "silent"
      : durationSeconds < 0.4
        ? "too_short"
        : !eligible
          ? "below_loudness_gate"
          : stream.channels > 2 && !stream.channelLayout
            ? "unknown_channel_layout"
            : "measured";
  const report: Analysis = {
    schemaVersion: 1,
    kind: "analysis",
    input,
    durationSeconds,
    frames: scanner.frames,
    decodedPcmSha256: stats.pcmHash,
    state,
    integratedLufs: state === "measured" ? finiteReading(integrated[1]) : null,
    truePeakDbtp: state === "silent" ? null : finiteReading(tp[1]),
    loudnessRangeLu:
      state === "measured" && durationSeconds >= 10 ? Number(range[1]) : null,
    samplePeakDbfs: stats.samplePeakDbfs,
    rmsDbfs: stats.rmsDbfs,
    channels: stats.channels,
    stereoCorrelation: stats.correlation,
    channelImbalanceDb: stats.imbalance,
    silence: {
      thresholdDbfs: scanner.threshold,
      minSeconds: scanner.minSilence,
      totalSeconds: scanner.totalSilence,
      leadingSeconds: scanner.leading,
      trailingSeconds: scanner.trailing,
      intervals: scanner.silenceIntervals,
      totalIntervals: scanner.silenceCount,
    },
    discontinuities: {
      threshold: scanner.jump,
      totalCandidates: scanner.discontinuityCount,
      candidates: scanner.discontinuities,
    },
    bandEnergy: {
      method: "one-pole-crossover",
      lowDbfs: stats.bands[0],
      midDbfs: stats.bands[1],
      highDbfs: stats.bands[2],
    },
    waveform: scanner.waveform,
    loudnessTimeline:
      state === "unknown_channel_layout"
        ? timeline.map((p) => ({
            ...p,
            momentaryLufs: null,
            shortTermLufs: null,
          }))
        : timeline,
    coverage: {
      waveformBinSeconds: Math.max(
        ...scanner.waveform.map((p) => p.endSeconds - p.startSeconds),
      ),
      loudnessStride: stride,
      eventsCapped:
        scanner.silenceCount > scanner.silenceIntervals.length ||
        scanner.discontinuityCount > scanner.discontinuities.length,
    },
    settings: {
      clippingThreshold: scanner.clipThreshold,
      nativeThreads: options.nativeThreads ?? 1,
    },
  };
  notify(options, {
    phase: "complete",
    fraction: 1,
    decodedSeconds: durationSeconds,
  });
  return report;
}
