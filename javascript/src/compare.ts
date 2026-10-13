import { analyze, db } from "./analysis.js";
import { localFile, notify, limits, mediaFormats } from "./input.js";
import { AuditError, aborted, positive } from "./errors.js";
import { run } from "./process.js";
import type { CompareOptions, Comparison, AlignmentWindow } from "./types.js";
async function window(
  file: string,
  start: number,
  duration: number,
  options: CompareOptions,
): Promise<Float64Array> {
  const input = await localFile(file, options);
  const r = await run(
    options.ffmpegPath ?? "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-xerror",
      "-threads",
      String(options.nativeThreads ?? 1),
      "-protocol_whitelist",
      "file,pipe",
      "-format_whitelist",
      mediaFormats,
      "-ss",
      String(start),
      "-i",
      input.path,
      "-t",
      String(duration),
      "-map",
      `0:${options.streamIndex ?? 0}`,
      "-vn",
      "-sn",
      "-dn",
      "-ac",
      "1",
      "-ar",
      "400",
      "-c:a",
      "pcm_f64le",
      "-f",
      "f64le",
      "pipe:1",
    ],
    {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      maxStdoutBytes: 200000,
    },
  );
  if (r.stdout.length % 8)
    throw new AuditError(
      "PCM_TRUNCATED",
      "The alignment window was incomplete.",
    );
  const out = new Float64Array(r.stdout.length / 8);
  for (let i = 0; i < out.length; i++) out[i] = r.stdout.readDoubleLE(i * 8);
  return out;
}
function correlation(
  a: Float64Array,
  b: Float64Array,
  offset: number,
): { score: number; gain: number; residual: number } | null {
  // Exclude resampler startup/tail transients from evidence of alignment.
  const start = Math.max(100, 100 - offset);
  const end = Math.min(a.length - 100, b.length - offset - 100);
  const n = end - start;
  if (n < 200) return null;
  let sa = 0,
    sb = 0,
    aa = 0,
    bb = 0,
    ab = 0;
  for (let i = start; i < end; i++) {
    const x = a[i],
      y = b[i + offset];
    sa += x;
    sb += y;
    aa += x * x;
    bb += y * y;
    ab += x * y;
  }
  const va = aa - (sa * sa) / n,
    vb = bb - (sb * sb) / n,
    cross = ab - (sa * sb) / n;
  if (va < 1e-15 || vb < 1e-15) return null;
  const gain = cross / va;
  return {
    score: cross / Math.sqrt(va * vb),
    gain,
    residual: Math.sqrt(Math.max(0, (vb - (cross * cross) / va) / n)),
  };
}
function align(
  a: Float64Array,
  b: Float64Array,
  maxLag: number,
  at: number,
): AlignmentWindow {
  const scored: {
    lag: number;
    score: number;
    gain: number;
    residual: number;
  }[] = [];
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const result = correlation(a, b, lag);
    if (result) scored.push({ lag, ...result });
  }
  scored.sort((x, y) => y.score - x.score);
  const best = scored[0];
  const second = best
    ? scored.find((s) => Math.abs(s.lag - best.lag) > 8)
    : undefined;
  const confidence = !best
    ? "unavailable"
    : best.score >= 0.8 && (!second || best.score - second.score > 0.03)
      ? "high"
      : "ambiguous";
  return {
    atSeconds: at,
    offsetSeconds: confidence === "high" ? best.lag / 400 : null,
    correlation: best?.score ?? null,
    confidence,
    gainDb: confidence === "high" ? db(Math.abs(best.gain)) : null,
    residualRms: confidence === "high" ? best.residual : null,
  };
}
export async function compare(
  beforeFile: string,
  afterFile: string,
  options: CompareOptions = {},
): Promise<Comparison> {
  limits(options);
  positive(options.maxAlignmentSeconds ?? 0.5, "maxAlignmentSeconds", 2);
  if (
    !Number.isFinite(options.toleranceSeconds ?? 0.05) ||
    (options.toleranceSeconds ?? 0.05) < 0
  )
    throw new AuditError(
      "CONFIG_INVALID",
      "toleranceSeconds must be finite and nonnegative.",
    );
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(options.timeoutMs ?? 3_600_000),
  ]);
  options = { ...options, signal };
  const before = await analyze(beforeFile, {
    ...options,
    onProgress: undefined,
  });
  const after = await analyze(afterFile, { ...options, onProgress: undefined });
  notify(options, { phase: "compare", fraction: 0 });
  const duration = Math.min(before.durationSeconds, after.durationSeconds);
  const width = Math.min(4, duration);
  const starts = [
    ...new Set([
      0,
      Math.max(0, duration / 2 - width / 2),
      Math.max(0, duration - width),
    ]),
  ];
  const alignment: AlignmentWindow[] = [];
  if (duration >= 0.5)
    for (const start of starts) {
      aborted(signal);
      const a = await window(beforeFile, start, width, {
        ...options,
        streamIndex: before.input.selectedStream.index,
      });
      const b = await window(afterFile, start, width, {
        ...options,
        streamIndex: after.input.selectedStream.index,
      });
      alignment.push(
        align(
          a,
          b,
          Math.round((options.maxAlignmentSeconds ?? 0.5) * 400),
          start,
        ),
      );
      notify(options, {
        phase: "compare",
        fraction: alignment.length / starts.length,
      });
    }
  const good = alignment.filter((w) => w.confidence === "high");
  const delta = after.durationSeconds - before.durationSeconds;
  const tolerance = options.toleranceSeconds ?? 0.05;
  const findings: Comparison["findings"] = [];
  const channelChange =
    before.channels.length !== after.channels.length ||
    (before.input.selectedStream.channelLayout !== null &&
      after.input.selectedStream.channelLayout !== null &&
      before.input.selectedStream.channelLayout !==
        after.input.selectedStream.channelLayout);
  if (
    before.input.selectedStream.channelLayout === null ||
    after.input.selectedStream.channelLayout === null
  )
    findings.push({
      code: "CHANNEL_LAYOUT_UNAVAILABLE",
      severity: "info",
      message:
        "A channel layout is unspecified; channel indices are compared without inferring speaker mapping.",
    });
  const sampleRateChange =
    before.input.selectedStream.sampleRate !==
    after.input.selectedStream.sampleRate;
  if (Math.abs(delta) > tolerance)
    findings.push({
      code: "DURATION_CHANGE",
      severity: options.allow?.trim ? "info" : "warning",
      message: "Decoded duration changed beyond the configured tolerance.",
    });
  if (channelChange)
    findings.push({
      code: "CHANNEL_CHANGE",
      severity: options.allow?.channels ? "info" : "warning",
      message: "Channel count or layout changed.",
    });
  if (sampleRateChange)
    findings.push({
      code: "SAMPLE_RATE_CHANGE",
      severity: options.allow?.resample ? "info" : "warning",
      message: "Sample rate changed.",
    });
  if (good.some((w) => Math.abs(w.offsetSeconds!) > tolerance))
    findings.push({
      code: "TIMING_OFFSET",
      severity: options.allow?.trim ? "info" : "warning",
      message: "A sampled window has a confident timing offset.",
    });
  const drift =
    good.length >= 2
      ? good.at(-1)!.offsetSeconds! - good[0].offsetSeconds!
      : null;
  if (drift !== null && Math.abs(drift) > tolerance)
    findings.push({
      code: "TIMING_DRIFT",
      severity: "warning",
      message: "Confident window offsets differ across the recording.",
    });
  if (good.some((w) => w.gainDb !== null && Math.abs(w.gainDb) > 0.5))
    findings.push({
      code: "GAIN_CHANGE",
      severity: options.allow?.gain ? "info" : "warning",
      message: "Aligned low-frequency windows indicate a gain change.",
    });
  if (
    after.discontinuities.totalCandidates >
    before.discontinuities.totalCandidates
  )
    findings.push({
      code: "DISCONTINUITY_INCREASE",
      severity: "warning",
      message:
        "More sample-jump candidates were found; transients can also cause these.",
    });
  const difference = (a: number | null, b: number | null): number | null =>
    a === null || b === null ? null : b - a;
  const report: Comparison = {
    schemaVersion: 1,
    kind: "comparison",
    before,
    after,
    decodedPcmEqual:
      !sampleRateChange &&
      !channelChange &&
      before.frames === after.frames &&
      before.decodedPcmSha256 === after.decodedPcmSha256,
    durationDeltaSeconds: delta,
    durationWithinTolerance: Math.abs(delta) <= tolerance,
    loudnessDeltaLu: difference(before.integratedLufs, after.integratedLufs),
    peakDeltaDb: difference(before.truePeakDbtp, after.truePeakDbtp),
    differences: {
      frames: after.frames - before.frames,
      rmsDb: difference(before.rmsDbfs, after.rmsDbfs),
      quietSeconds: after.silence.totalSeconds - before.silence.totalSeconds,
      leadingQuietSeconds:
        after.silence.leadingSeconds - before.silence.leadingSeconds,
      trailingQuietSeconds:
        after.silence.trailingSeconds - before.silence.trailingSeconds,
      channelImbalanceDb: difference(
        before.channelImbalanceDb,
        after.channelImbalanceDb,
      ),
      bandsDb: {
        low: difference(before.bandEnergy.lowDbfs, after.bandEnergy.lowDbfs),
        mid: difference(before.bandEnergy.midDbfs, after.bandEnergy.midDbfs),
        high: difference(before.bandEnergy.highDbfs, after.bandEnergy.highDbfs),
      },
      channels: channelChange
        ? []
        : before.channels.map((channel, i) => ({
            channel: i,
            rmsDb: difference(channel.rmsDbfs, after.channels[i].rmsDbfs),
            samplePeakDb: difference(
              channel.samplePeakDbfs,
              after.channels[i].samplePeakDbfs,
            ),
            dcOffset: after.channels[i].dcOffset - channel.dcOffset,
          })),
    },
    channelChange,
    sampleRateChange,
    alignment,
    driftSeconds: drift,
    findings,
    limitations: [
      "Alignment samples up to three mono low-pass windows at 400 Hz (2.5 ms resolution). It does not prove full-file alignment or intelligibility.",
      "Ambiguous or silent windows do not yield an offset. Codec padding and intended edits require explicit tolerances.",
      "A waveform comparison cannot establish subjective speech or music quality.",
      "Channel count/layout and per-channel levels are compared; channel swaps with identical levels are not resolved by mono alignment windows.",
    ],
  };
  notify(options, { phase: "complete", fraction: 1 });
  return report;
}
