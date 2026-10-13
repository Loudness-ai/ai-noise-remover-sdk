# Python API reference

Import from `loudness_audio_kit`. Public functions accept local `str`/`PathLike` file paths, an optional `Options` object and documented keyword overrides. Unknown keywords and invalid values raise `AudioError("CONFIG_INVALID", ...)`. Results are dictionaries using snake_case and `schema_version: 1`; JSON output contains finite numbers or `null` for unavailable measurements.

## Processing

`process_audio(input, output, mode="enhance", options=None, **kwargs)` dispatches `denoise`, `enhance`, `normalize` or `convert`. The four named functions have the same input/output/options signature. `process_audio_async` has the dispatch signature and returns an awaitable. Its processing and progress callbacks run in a worker thread, so callbacks must marshal UI/event-loop changes appropriately.

A processing result contains `mode`, input inspection, output path/format/rate/channels/duration/bytes, applied settings, decoded output analysis, warnings and metrics. Metrics include whole-job wall time, model initialization time, inference time, sampled peak child-tree RSS and temporary audio bytes. They are measurements of that run, not capacity estimates.

## Options

| Name | Default | Accepted values / use |
| --- | --- | --- |
| `timeout_seconds` | 3600 | 0.001–2,147,483; absolute whole-job deadline |
| `max_file_bytes` | 10,737,418,240 | Positive integer ≤ 2^53−1 |
| `max_duration_seconds` | 86400 | >0 through 604800; checked during decoding too |
| `max_temp_bytes` | 4,294,967,296 | Integer 1024 through 2^53−1 |
| `memory_budget_mib` | 512 | Integer 32–65536; sampled owned child RSS |
| `native_threads` | 1 | Integer 1–256; native thread setting, not total process thread count |
| `ffmpeg_path`, `ffprobe_path` | `ffmpeg`, `ffprobe` | Trusted local executable names or paths |
| `model_dir` | Bundled pinned assets | Local directory containing the exact checksum-validated graph/state contract |
| `temp_directory` | OS default | Existing private service-owned directory |
| `stream_index` | `None` | Absolute audio-stream index, 0–100000 |
| `format` | Output suffix | `wav`, `flac`, `mp3`, `opus` |
| `bit_depth` | 16 | 16 or 24; lossless formats only |
| `bitrate_kbps` | 192 | Integer 16–320; lossy formats only, subject to codec/channel support |
| `sample_rate` | Source rate | Integer 8000–192000; MP3 supports a subset, Opus requires 48000 |
| `channels` | Source count | Integer 1–8; MP3/Opus at most 2 |
| `strength` | 1 | 0–1, applied only by denoise/enhance |
| `target_lufs` | −16 | −70 through −5 |
| `true_peak_dbtp` | −1.5 | −9 through 0 |
| `loudness_range_lu` | 11 | 1–50 |
| `normalize` | Mode default | `None`, `True`, `False`; normalize mode always normalizes |
| `voice_processing` | `True` | Boolean; finishing high-pass/compression in enhance mode |
| `overwrite` | `False` | Boolean; explicitly permit replacing an existing independent regular output |
| `cancel_token` | `None` | `CancellationToken` |
| `on_progress` | `None` | Callable accepting one event dictionary |
| `max_points` | 2048 | Integer 16–16384; waveform/timeline detail |
| `max_events` | 128 | Integer 0–10000; event detail |
| `silence_threshold_dbfs` | −60 | −180 through 0 |
| `min_silence_seconds` | 0.2 | >0 through 86400 |
| `clipping_threshold` | 0.999 | >0 through 2; near-full-scale sample threshold |
| `discontinuity_threshold` | 0.8 | >0 through 4; candidate sample jump |

`Options` is immutable. Use `dataclasses.replace` for changed configurations. Keywords override only the named fields of an existing configuration. A full `Options` object supplied to an `AudioClient` job intentionally replaces its defaults; per-job memory and thread reservations cannot exceed the client's admitted per-job reservation.

## Shared client

`AudioClient(options=None, concurrency=None, total_memory_budget_mib=None, cpu_thread_budget=None, max_queued=10000, **kwargs)` owns a bounded scheduler. Automatic concurrency is at most 8, bounded by detected CPU count and half available host memory. Explicit concurrency accepts 1–256; total memory accepts 32–1,048,576 MiB; thread budget accepts 1–65536; `max_queued` accepts 1–100000. These reservations govern this client, not other processes or other clients. Container users must set budgets to their assigned limits rather than relying on host detection.

`submit(input, output, mode="enhance", options=None, **kwargs)` returns `AudioFuture`. `process` blocks on the same job; convenience `denoise/enhance/normalize/convert` accept option keywords. `inspect/analyze` also share the queue. One deadline starts at submission and includes queued time. The queue rejects new work with `QUEUE_FULL`; cancelled queued executor entries retain admission until drained to prevent cancellation from growing an unbounded queue.

`AudioFuture.cancel()` returns whether a stop request was accepted. `result(timeout=...)` raises `AudioError("CANCELLED", ...)` after physical cleanup; that wait timeout only limits the caller's wait and does not cancel the job. Use the `Options.timeout_seconds` budget or cancel explicitly. `close()` cancels all owned jobs and joins them. Context-manager exit calls `close()`.

`process_batch(jobs, options=None, concurrency=None, total_memory_budget_mib=None, cpu_thread_budget=None, max_queued=10000, fail_fast=False, **kwargs)` takes 1–`max_queued` dictionaries with `input`, `output`, optional `mode` and optional `options` mapping. It rejects duplicate destinations and outputs aliasing any batch input before launch. Results retain input order and include completed/failed/cancelled state per job. The batch deadline includes preflight; per-job deadlines also apply. Fail-fast requests cancellation for unfinished work; already published successes remain. `batch(files, ...)` performs ordered analysis with the same scheduling budgets.

## Inspection, measurements and reports

`inspect(file, options=None, **kwargs)` returns selected audio-stream/container metadata. `analyze` decodes the entire stream and measures it. `validate(file, policy, options=None, **kwargs)` analyzes then evaluates; `evaluate(analysis, policy)` uses an existing structurally checked report. `EXAMPLE_POLICY` is an example, not a universal mastering standard.

`compare(before, after, options=None, tolerance_seconds=0.05, max_alignment_seconds=0.5, allow=None, **kwargs)` measures both files. Maximum searched offset is configurable from 0–2 seconds. `allow` can contain boolean `trim`, `resample`, `channels`, `gain`, changing finding severity rather than hiding measurements.

`check_report(report)` validates version/kind, finite JSON, a 32 MiB serialized cap and the nested measurement structure consumed by policies/reports. `render_report(report, title=...)` returns portable escaped HTML, with CSP and no script or remote assets. Save it yourself or use the report CLI. Extra diagnostic fields are retained; this check is not a cryptographic authenticity check.

`benchmark(manifest, options=None, **kwargs)` runs trusted executable argument lists without a shell. The manifest includes fixture paths/checksums/licenses and uniquely named processors with executable, args, version and settings. Args use `{input}`/`{output}` placeholders. Repetitions/warmups are bounded, and each run has fresh private scratch. Never expose this API to user-supplied manifests.

`doctor(options=None, **kwargs)` checks native tools and filters. `processing_doctor(...)` additionally exercises the pinned local speech engine and an export. Neither downloads a model.

## Errors and progress

`AudioError` has `code`, a concise `message` and `to_dict()`. Common codes include `CONFIG_INVALID`, `INPUT_UNREADABLE`, `MEDIA_INVALID`, `STREAM_REQUIRED`, `FILE_LIMIT`, `DURATION_LIMIT`, `MEMORY_LIMIT`, `TEMP_LIMIT`, `TIMEOUT`, `CANCELLED`, `OUTPUT_SPACE`, `OUTPUT_EXISTS`, `OUTPUT_CLOBBER`, `INPUT_CHANGED`, `DEPENDENCY_MISSING`, `MODEL_INVALID`, `QUEUE_FULL`, `REPORT_INVALID`, `POLICY_INVALID`, `DECODE_FAILED`, `OBSERVER_ERROR` and `TERMINATION_FAILED`. Do not derive retry behavior from message text.

Progress events contain `phase`, a phase-relative `fraction` or `None`, and optional `decoded_seconds`. Phases include inspect, initialize, decode/denoise, normalize, export, verify, complete and benchmark/compare. Fractions do not claim a global ETA. Callback failure stops and cleans up before publication; failure of the final completion notification cannot undo a committed output.
