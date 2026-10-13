export type Nullable = number | null;
export type ProgressPhase =
  | "inspect"
  | "decode"
  | "compare"
  | "benchmark"
  | "initialize"
  | "denoise"
  | "normalize"
  | "export"
  | "verify"
  | "complete";
export interface Progress {
  phase: ProgressPhase;
  fraction: Nullable;
  decodedSeconds?: number;
}
export interface Options {
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
  ffmpegPath?: string;
  ffprobePath?: string;
  timeoutMs?: number;
  maxFileBytes?: number;
  maxDurationSeconds?: number;
  streamIndex?: number;
  nativeThreads?: number;
  memoryBudgetMiB?: number;
  maxPoints?: number;
  maxEvents?: number;
  silenceThresholdDbfs?: number;
  minSilenceSeconds?: number;
  clippingThreshold?: number;
  discontinuityThreshold?: number;
}
export interface AudioStream {
  index: number;
  codec: string;
  sampleRate: number;
  channels: number;
  channelLayout: string | null;
  declaredDurationSeconds: Nullable;
  language: string | null;
}
export interface Inspection {
  schemaVersion: 1;
  kind: "inspection";
  file: { name: string; sizeBytes: number; container: string };
  streams: AudioStream[];
  selectedStream: AudioStream;
  declaredDurationSeconds: Nullable;
}
export interface ChannelMeasurement {
  samplePeakDbfs: Nullable;
  rmsDbfs: Nullable;
  crestFactorDb: Nullable;
  dcOffset: number;
  nearFullScaleSamples: number;
  longestNearFullScaleRun: number;
}
export interface Interval {
  startSeconds: number;
  endSeconds: number;
}
export interface WavePoint extends Interval {
  min: number;
  max: number;
  rms: number;
}
export interface LoudnessPoint {
  timeSeconds: number;
  momentaryLufs: Nullable;
  shortTermLufs: Nullable;
}
export interface Analysis {
  schemaVersion: 1;
  kind: "analysis";
  input: Inspection;
  durationSeconds: number;
  frames: number;
  decodedPcmSha256: string;
  state:
    | "measured"
    | "silent"
    | "too_short"
    | "below_loudness_gate"
    | "unknown_channel_layout";
  integratedLufs: Nullable;
  truePeakDbtp: Nullable;
  loudnessRangeLu: Nullable;
  samplePeakDbfs: Nullable;
  rmsDbfs: Nullable;
  channels: ChannelMeasurement[];
  stereoCorrelation: Nullable;
  channelImbalanceDb: Nullable;
  silence: {
    thresholdDbfs: number;
    minSeconds: number;
    totalSeconds: number;
    leadingSeconds: number;
    trailingSeconds: number;
    intervals: Interval[];
    totalIntervals: number;
  };
  discontinuities: {
    threshold: number;
    totalCandidates: number;
    candidates: { timeSeconds: number; channel: number }[];
  };
  bandEnergy: {
    method: "one-pole-crossover";
    lowDbfs: Nullable;
    midDbfs: Nullable;
    highDbfs: Nullable;
  };
  waveform: WavePoint[];
  loudnessTimeline: LoudnessPoint[];
  coverage: {
    waveformBinSeconds: number;
    loudnessStride: number;
    eventsCapped: boolean;
  };
  settings: { clippingThreshold: number; nativeThreads: number };
}
export type Metric =
  | "durationSeconds"
  | "sizeBytes"
  | "channels"
  | "sampleRate"
  | "integratedLufs"
  | "truePeakDbtp"
  | "samplePeakDbfs"
  | "rmsDbfs"
  | "nearFullScaleSamples"
  | "longestNearFullScaleRun"
  | "maxAbsDcOffset"
  | "silenceSeconds"
  | "leadingSilenceSeconds"
  | "trailingSilenceSeconds"
  | "channelImbalanceDb";
export interface NumericRule {
  metric: Metric;
  min?: number;
  max?: number;
  severity?: "warning" | "fail";
}
export interface Policy {
  schemaVersion: 1;
  name: string;
  rules: NumericRule[];
  codecs?: string[];
  containers?: string[];
  unavailable?: "warning" | "fail";
}
export interface RuleResult {
  metric: string;
  unit: string;
  status: "pass" | "warning" | "fail" | "unavailable";
  value: number | string | null;
  min?: number;
  max?: number;
  message: string;
}
export interface Validation {
  schemaVersion: 1;
  kind: "validation";
  policy: Policy;
  passed: boolean;
  failed: boolean;
  results: RuleResult[];
  analysis: Analysis;
}
export interface CompareOptions extends Options {
  toleranceSeconds?: number;
  maxAlignmentSeconds?: number;
  allow?: {
    trim?: boolean;
    resample?: boolean;
    channels?: boolean;
    gain?: boolean;
  };
}
export interface AlignmentWindow {
  atSeconds: number;
  offsetSeconds: Nullable;
  correlation: Nullable;
  confidence: "high" | "ambiguous" | "unavailable";
  gainDb: Nullable;
  residualRms: Nullable;
}
export interface Comparison {
  schemaVersion: 1;
  kind: "comparison";
  before: Analysis;
  after: Analysis;
  decodedPcmEqual: boolean;
  durationDeltaSeconds: number;
  durationWithinTolerance: boolean;
  loudnessDeltaLu: Nullable;
  peakDeltaDb: Nullable;
  differences: {
    frames: number;
    rmsDb: Nullable;
    quietSeconds: number;
    leadingQuietSeconds: number;
    trailingQuietSeconds: number;
    channelImbalanceDb: Nullable;
    bandsDb: { low: Nullable; mid: Nullable; high: Nullable };
    channels: {
      channel: number;
      rmsDb: Nullable;
      samplePeakDb: Nullable;
      dcOffset: number;
    }[];
  };
  channelChange: boolean;
  sampleRateChange: boolean;
  alignment: AlignmentWindow[];
  driftSeconds: Nullable;
  findings: { code: string; severity: "info" | "warning"; message: string }[];
  limitations: string[];
}
export interface BatchOptions extends Options {
  concurrency?: number;
  maxQueued?: number;
  failFast?: boolean;
}
export interface BatchItem {
  file: string;
  state: "completed" | "failed" | "cancelled";
  analysis?: Analysis;
  error?: { code: string; message: string };
}
export interface Batch {
  schemaVersion: 1;
  kind: "batch";
  concurrency: number;
  results: BatchItem[];
}
export interface BenchmarkFixture {
  path: string;
  sha256: string;
  license: string;
}
export interface Processor {
  name: string;
  executable: string;
  args: string[];
  version: string;
  settings: Record<string, string | number | boolean>;
}
export interface BenchmarkManifest {
  schemaVersion: 1;
  fixtures: BenchmarkFixture[];
  processors: Processor[];
  repetitions: number;
  warmup: number;
  policy?: Policy;
  comparison?: boolean;
  expectations?: {
    durationToleranceSeconds?: number;
    allowDurationChange?: boolean;
  };
}
export interface ProcessMetrics {
  sampledPeakTreeRssBytes: Nullable;
  samplingIntervalMs: number;
  parentRssBytes: number;
  memoryMethod: string;
  wallMs: number;
}
export interface BenchmarkRun {
  fixture: string;
  processor: string;
  repetition: number;
  temperature: "first" | "subsequent";
  metrics: ProcessMetrics;
  setupMs: number;
  sampledPeakScratchBytes: Nullable;
  scratchSamplingIntervalMs: number;
  state: "completed" | "failed";
  validation?: Validation;
  comparison?: Comparison;
  error?: { code: string; message: string };
}
export interface Benchmark {
  schemaVersion: 1;
  kind: "benchmark";
  environment: {
    platform: string;
    arch: string;
    node: string;
    cpus: string;
    cpuCount: number;
    nativeVersions: Record<string, string>;
  };
  manifest: BenchmarkManifest;
  runs: BenchmarkRun[];
  summaries: {
    fixture: string;
    processor: string;
    successes: number;
    failures: number;
    medianMs: Nullable;
    p95Ms: Nullable;
  }[];
  limitations: string[];
}
export type Report =
  | Analysis
  | Inspection
  | Validation
  | Comparison
  | Batch
  | Benchmark;
