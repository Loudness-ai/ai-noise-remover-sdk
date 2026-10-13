# Verification evidence

Verification date: 13 October 2026. Evidence refers to the locally delivered Python package, not a public PyPI release. Tests process actual audio with the pinned graph and installed native executables; mocked fault cases supplement that work.

The final matrix and archive hashes are recorded in the accompanying `verification-evidence.tar.gz` and `release-receipt.json`. This source document deliberately does not embed its own archive hash. Review the receipt and machine-readable JUnit/JSON records together.

## Processing and lifecycle

The regression suite covers four processing modes; WAV16/24, FLAC16/24, MP3 and Opus; source/output rates; independent stereo channels; clips shorter than a frame; full recording tails; strength-zero behavior; measured normalization and silent material; input/output aliases and collisions; source changes; queued/active/async cancellation; SIGINT/SIGTERM cleanup; observer failures; bounded queues; file/duration/time/temp/RSS limits; real concurrent workers; corrupted media; measurements/policies/comparisons/reports; trusted benchmarks; CLI and malformed JSON.

The independent full-buffer reference verifies the frame adapter against the same pinned graph. A separate JavaScript parity script checked two credited speech recordings through both denoise and enhance: all four outputs had exact decoded PCM equality and identical frame counts, with measurement differences within 0.001. This checks wrapper behavior on those fixtures; it is not a broad perceptual-quality benchmark or proof of model redistribution rights.

## Long recording

On macOS 26.6.1 arm64, Python 3.12.14, FFmpeg 8.1.2, a generated one-hour 16 kHz mono WAV was denoised and exported at its original rate. All 57,600,000 output frames were retained. The measured wall time was 305.13 seconds, with 201,146,368 bytes of sampled peak owned child-tree RSS and 806,400,114 temporary audio bytes. Ten subsequent jobs left zero private scratch directories. The caller's Python/measurement memory is excluded from the RSS statistic. Hardware, competing workloads and content affect speed; this result is not server-capacity proof.

## Installed distribution checks

| Environment | Distribution under test | Final suite |
| --- | --- | --- |
| macOS 26.6.1 ARM64, CPython 3.12.14 | Clean source install outside checkout; separate clean wheel consumer | 103 passed |
| Linux ARM64, CPython 3.11.17 | Installed wheel, non-root, offline | 103 passed |
| Linux ARM64, CPython 3.14.8 | Installed wheel, non-root, offline | 103 passed |
| Linux x86-64, CPython 3.12.15, Docker Desktop/Rosetta emulation | Installed wheel, non-root, offline | 103 passed |

Wheel and source archive installs are exercised outside the source checkout. The consumer checks every processing mode through SDK and CLI, actual processing readiness, comparison, reporting and batch processing. The final tests use normal CPython on macOS and Linux ARM64 at the declared Python boundaries, plus Linux x86-64 under Docker Desktop emulation. x86 emulation checks functionality, not native throughput. Windows and free-threaded Python have not been verified and are not claimed by this delivery.

Linux verification runs under a non-root account with networking disabled and a separate 2 MiB tmpfs disk-full case. ARM64 runs used a 4 GiB memory and four-CPU quota. One CPU-limited x86 emulated run intermittently stalled with emulator threads waiting; its isolated queue test passed. The final complete x86 rerun used 4 GiB memory, single-thread host BLAS settings and no CPU quota. No package behavior was changed to conceal that result. Native x86 load/capacity testing remains necessary before making server-performance claims.

Physical exhaustion returned `OUTPUT_SPACE`, preserved the source, left no stage/scratch and published no partial output in each final Linux consumer. Installation can use package registries; actual built-in processing is local and succeeds without networking.

Ruff checks formatting/lint, Mypy checks the SDK, Twine checks archive metadata, and archive inspection verifies package boundaries and exact source/model/brand bytes. Runtime dependencies are audited for known vulnerabilities using the exact installed resolutions; the audit is a dated advisory check, not a security guarantee. Source includes credited fixtures and tests; wheel excludes them and the private website code/fonts. The exact model release identity and adopted licensing interpretation are documented separately in [provenance](provenance.md); runtime tests do not establish licensing rights.
