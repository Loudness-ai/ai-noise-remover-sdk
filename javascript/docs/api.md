# API contracts

Import from `loudness-audio-kit` in ESM or CommonJS. Strict TypeScript declarations accompany both distributions. `/core` exposes audit primitives, `/processing` exposes local file processing, `/report` exposes offline HTML reports, and `/benchmark` exposes the trusted-command benchmark harness.

## Local processing

```ts
denoise(input: string, output: string, options?: ProcessingOptions): Promise<ProcessingResult>
enhance(input: string, output: string, options?: ProcessingOptions): Promise<ProcessingResult>
normalize(input: string, output: string, options?: ProcessingOptions): Promise<ProcessingResult>
convert(input: string, output: string, options?: ProcessingOptions): Promise<ProcessingResult>
processAudio(input, output, mode, options?): Promise<ProcessingResult>
processingDoctor(options?): Promise<{ ready: boolean; versions: Record<string,string>; errors: string[]; speechEngine: 'ready' | 'unavailable' }>
```

Input and output are local file paths; the output parent must already exist. File extension selects `wav`, `flac`, `mp3` or `opus` unless `format` is explicit. An explicit format controls the file content even if its extension differs; prefer matching extensions. Symlink/nonregular destinations and source aliases are rejected. The source path is resolved and checked for size/readability and stable identity before processing and again before commit. Do not modify source audio while a job runs.

### Processing options

| Option | Default / range | Meaning |
| --- | --- | --- |
| `strength` | 1, 0–1 | Wet/dry mix for denoise/enhance; delay-aligned. Zero bypasses the model. Has no effect in convert/normalize. |
| `normalize` | True for enhance, false for denoise/convert | Prepare measured loudness. Normalize mode always enables this stage. |
| `voiceProcessing` | True for enhance | High-pass and gentle compression; applies to enhance only. |
| `targetLufs` | −16, −70 to −5 | Integrated loudness target when normalization is enabled. |
| `truePeakDbtp` | −1.5, −9 to 0 | Normalization true-peak ceiling. Lossy codecs can overshoot after decoding; final analysis reports this. |
| `loudnessRangeLu` | 11, 1–50 | Requested normalization loudness range. Native normalization may use dynamic processing when linear targets are infeasible. |
| `format` | Output extension | WAV, FLAC, MP3 or Opus. |
| `bitDepth` | 16, 16 or 24 | Lossless WAV/FLAC output depth; ignored for lossy codecs. |
| `bitrateKbps` | MP3 192 / Opus 128; 16–320 | Lossy encoding bitrate; ignored for lossless codecs. |
| `sampleRate` | Source rate, 8000–192000 | Output rate. MP3 requires a codec-supported rate; Opus requires 48000. |
| `channels` | Source count, 1–8 | Explicit output channel count. MP3/Opus support 1–2 here. |
| `overwrite` | False | Deliberate atomic replacement of a regular destination; never permits source replacement. |
| `maxFileBytes` | 10737418240 | Positive safe integer. Source byte admission. |
| `maxDurationSeconds` | 86400; positive, up to 604800 | Enforced against declared and actual decoded duration. |
| `timeoutMs` | 3600000; 1–2147483647 | Whole-operation deadline, including client queue time. |
| `maxTempBytes` | 4294967296; integer ≥1024 | Combined raw audio and staged encoded audio. Does not count final existing destination or model/library files. |
| `memoryBudgetMiB` | 512; integer 32–65536 | Stop threshold for sampled owned child-process-group RSS. See memory limitations below. |
| `nativeThreads` | 1; integer 1–256 | Decoder/inference thread configuration; not a count of every native runtime/helper thread. |
| `streamIndex` | Unique audio stream | Absolute input stream index; required when input has several audio streams. |
| `ffmpegPath`, `ffprobePath` | Executable names on PATH | Local executable paths, passed without a shell. |
| `modelDir` | Bundled pinned assets | Directory containing the exact compatible checksummed graph and state files. Different models require a new adapter, not merely this option. |
| `tempDirectory` | OS temp directory | Existing private scratch parent. Encoded staging always resides beside the output for atomic commit. |
| `signal` | None | AbortSignal for cancellation. |
| `onProgress` | None | Non-owning observer. Exceptions/rejected observer promises are ignored. Abort through `signal` instead. |

Inherited measurement controls include `maxPoints` (2048; 16–16384), `maxEvents` (128; 0–10000), `silenceThresholdDbfs` (−60), `minSilenceSeconds` (0.2), `clippingThreshold` (0.999) and `discontinuityThreshold` (0.8). They control bounded final analysis, not the denoiser's strength.

Progress phases: inspect, initialize, denoise/decode, normalize, export, verify, complete. Fractions may be `null` when progress cannot be estimated reliably. These are processing observations, not a promise of exact remaining time.

### Results

`ProcessingResult` has `schemaVersion: 1`, `kind: 'processing'`, mode, source inspection, actual output path/name/bytes/rate/channels/duration, applied settings, full output analysis, warnings and metrics. `settings.normalized` is false if no gated loudness can be measured. Silent/infeasible targets and final codec peak/loudness deviations are reported rather than hidden. `metrics` includes total wall time, initialization, inference time, sampled peak child-tree RSS and raw+staged temporary audio bytes. RSS is measured for worker/normalization/export groups; it excludes the SDK host's retained report memory and does not represent a hard allocator ceiling. Some very short processes may finish before a sample; platform tooling can make RSS unavailable.

The returned local `output.path` is useful for developer integration. Do not pass private server paths to a public UI; the demo returns a deliberately small path-free summary.

## Client and batches

```ts
createAudioClient(options?: AudioClientOptions): AudioClient
processBatch(jobs: ProcessingJob[], options?: ProcessingBatchOptions): Promise<ProcessingBatchResult>
```

An AudioClient exposes process, denoise, enhance, normalize, convert, analyze, inspect, validate and compare on one shared scheduler. `state` reports active/queued/closed; `close()` aborts and waits for active/queued cleanup. Reuse one client per owning service/admission domain. Standalone functions do not share a hidden global pool.

Client options: `concurrency` 1–256, `maxQueued` 1–100000 (default10000), `maxNativeThreads` 1–65536 (default256), `totalMemoryBudgetMiB` 32–1048576. Auto concurrency is the minimum of 8, available CPUs and configured job memory slots. Auto total memory reservation uses half the available system/process memory, with at least one job reservation. This is a scheduling estimate; reserve additional memory for the host and other services.

`concurrency × memoryBudgetMiB` must fit `totalMemoryBudgetMiB`; `concurrency × nativeThreads` must fit `maxNativeThreads`. Per-job memory may be lowered but not raised beyond its reservation. Per-job native threads cannot override the client thread count. A queued deadline or signal cancels admission without starting the native job. Closing a client rejects future submissions with `POOL_CLOSED`.

A ProcessingJob is `{ input, output, mode?: 'enhance'|'denoise'|'normalize'|'convert', options? }`; default mode is enhance. The batch preflights sources/destinations and duplicate output paths, then returns ordered per-job outcomes. Each outcome is completed/result, failed/error or cancelled/error. `failFast: true` stops remaining work after the first failure; already committed files remain. Global timeout/user abort rejects after cleanup; ordinary individual failures return outcomes. Individual job AbortSignals are preserved. CLI manifests are JSON arrays; input/output paths resolve relative to the manifest. Other option paths retain their normal process-cwd meaning.

## Audit and report APIs

`inspect(file, options)`, `analyze(file, options)`, `validate(file, policy, options)`, `evaluate(analysis, policy)`, `compare(before, after, options)`, `batch(files, options)`, `createAuditor(options)`, `doctor(options)`, `benchmark(manifest, options)` and `renderHtml(report)` remain available. See [measurements](measurements.md) and [benchmark contracts](benchmarks.md).

Policies use schemaVersion1 and named rules with a metric, optional channel scope and min/max limits. Measurement nulls carry explicit states; do not convert unmeasurable values to zero. Comparisons are objective differences plus confidence-qualified sampled alignment, not perceptual speech quality scores. `batch` is audit-only; use `processBatch` to produce audio files.

Public JSON schemas include Analysis, Inspection, Comparison, Validation, BatchResult, BenchmarkResult, Report, Policy, BenchmarkManifest, ProcessingResult and ProcessingBatchResult. Generated schemas are checked against public TypeScript contracts.

## Errors and ownership

Stable `AuditError.code` values include CONFIG_INVALID, INPUT_INVALID, INPUT_CHANGED, FILE_LIMIT, DURATION_LIMIT, STREAM_AMBIGUOUS, OUTPUT_INVALID, OUTPUT_EXISTS, OUTPUT_CLOBBER, OUTPUT_COLLISION, OUTPUT_DIRECTORY, OUTPUT_SPACE, OUTPUT_PERMISSION, MODEL_MISSING, MODEL_INVALID, PCM_INVALID, DECODE_FAILED, TEMP_LIMIT, MEMORY_LIMIT, DEPENDENCY_MISSING, PROCESS_FAILED, TIMEOUT, CANCELLED, QUEUE_LIMIT, POOL_CLOSED and termination errors. Raw native logs are not public API responses. Catch errors, clean up your own upload storage, and retain already returned completed files according to your application's policy.

Abort/deadline is cooperative at JavaScript boundaries and physically fenced for owned children. A process that cannot be confirmed stopped yields a termination error, not a fabricated clean cancellation. Hard kill of the host or machine power loss can leave scratch files; use an application-owned scratch root and retention sweeper for crash recovery. Ordinary successful, failed, timed out, disconnected and cancelled requests are cleaned synchronously by the provided pipeline/demo.
