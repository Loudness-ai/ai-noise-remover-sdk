# Reproducible processor benchmarks

A manifest schedules trusted local executables using argument arrays, never a shell. Each fixture has a SHA-256, a license/rights label and a unique basename. Processor versions/settings are supplied explicitly: record the actual build, precision, thread count and operation. Manifests are not accepted by the public demonstration.

`repetitions` counts retained runs; `warmup` runs are executed and checked but excluded from timing distributions. At most 1000 total runs, including warmup, may be scheduled. Analysis summaries default to 64 points and 32 events per run; benchmark options permit at most 256 points and 128 events. Results retain all measured runs, so memory still grows with retained result count.

The harness also caps its conservative estimated report complexity at 900000 nodes before launching a processor. Reduce repetitions, points, events or policy rules if the requested result exceeds this budget. This keeps an accepted benchmark renderable within the report validator's bound; it is not an operating-system memory quota.

The private input copy is checksum checked before execution and the original is checksum checked after each run. An unexpected source change invalidates the run instead of preserving a misleading timing result.

Each run creates a private directory and copies its input before starting the processor. Copy/setup time is recorded separately from processing wall time. The `{input}` placeholder points to that copy and `{output}` to a regular output file in the directory. This protects an original from an accidental in-place rewrite; it does not sandbox an arbitrary executable. A trusted program can access everything permitted to its operating-system user.

Output must decode completely and satisfy its configured policy. Its duration must match the input within 0.05 seconds even with `comparison: false`. Configure `expectations.durationToleranceSeconds` when codec padding needs another tolerance; deliberate trimming requires `expectations.allowDurationChange: true`. Failed/invalid/incomplete outputs are retained as failures and excluded from successful timing statistics. Optional full comparison adds levels, quiet/band/channel changes and sampled alignment.

Memory is process-group RSS sampled every 100 ms on supported POSIX installations with `ps`; the wrapper's RSS is observed separately. Windows memory is unavailable. Scratch logical file bytes are also sampled every 100 ms, include the input copy, exclude external caches and do not follow symlinks. More than 10000 entries, excessive depth or a sampling error yields `null`. These are sampled maxima, not physical disk-block counts or guarantees that a short peak was observed.

First/subsequent describes launch order. It does not establish cold/warm disk or model-cache state. The harness starts a new process each run. Detached workers, remote services and independently running model servers are outside its accounting; measure their idle/active memory separately before publishing a service comparison. Output analysis/comparison time is excluded from processor wall time. p95 requires at least 20 successful retained runs.

`examples/workflows.mjs` constructs a runnable checksum-verified native conversion benchmark. `examples/benchmark.json` is a template requiring actual fixture/version/license values; it intentionally cannot run unchanged. Do not put credentials or private configuration in manifests you intend to share.

No benchmark result establishes speech intelligibility, music transcription quality or superiority over another model. Match task, media, precision, channels, rate and output expectations before interpreting speed/memory differences.
