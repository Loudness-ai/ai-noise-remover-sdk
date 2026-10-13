# Verification ledger

Initial local checks executed 13 October 2026 (Asia/Karachi). The public source repository is now [Loudness.ai Audio Kit](https://github.com/secretheart49/loudness-audio-kit). Current platform-matrix results and installed-package checks are recorded in [GitHub Actions](https://github.com/secretheart49/loudness-audio-kit/actions/workflows/ci.yml); the table below preserves the initial local measurements. Registry and Space publication are separate.

## Executed platform checks

| Environment | Runtime/native tools | Result |
| --- | --- | --- |
| macOS arm64, Apple M4 | Node 22.22.3; FFmpeg/FFprobe 8.1.2 | 92/92 tests; strict ESM/CJS declarations; actual installed SDK/CLI audio processing |
| macOS arm64 | Node 24.21.0; FFmpeg/FFprobe 8.1.2 | 92/92 tests |
| Linux arm64, Debian Bookworm container | Node 22.23.3; FFmpeg/FFprobe 5.1.9 | 92/92 tests; non-root HTTP enhancement/denoising and cancellation |
| Linux arm64, Debian Bookworm container | Node 24.21.0; FFmpeg/FFprobe 5.1.9 | 92/92 tests |
| Linux amd64 container emulated on this Mac | Node 22.23.3 | Built image; non-root actual enhancement/denoising, audit endpoints and cancellation smoke passed. Not a native performance claim. |
| Isolated clean source copy | macOS Node 22 | Fresh dependency installation, 92 tests, types, schemas, installed-package workflows and lint passed |
| Browser demo | Chromium/Playwright; 1280×800, 768/390/320×844 | Upload, advancing playback, pause, WAV download, real noisy-speech example, reset/cancel and no horizontal overflow |

Browser plugin not available. Acquisition of the user's regular Chrome through CUA failed with a request-header-policy loading error; isolated Playwright was used without changing the user's tabs. Current app console errors/warnings: 0. Initial missing favicon 404 was corrected. Screenshots use viewports because this headless full-page compositor produced repeated stitched bands; DOM had one header.

Native Windows was not executed during the initial local checks. Public CI exercises Node 22/24 on Linux/macOS/Windows, including actual inference, export, cancellation, installed-package and TypeScript consumers. Follow the completed run result rather than treating the configured matrix as proof. The Windows RSS sampler is unavailable.

## Actual speech output and reference checks

- Pinned model total delay 1536 samples is compensated, with complete final frame flushing and independent per-channel state. Tests cover 1, 77, 511, 512, 513 and 1025 sample clips, stereo silence independence, original 44.1 kHz output and real narration alignment/tail energy.
- Two CC-BY-4.0 narration fixtures with seeded 10 dB added white noise improved SI-SDR from 10.01/10.01 dB to 21.13/18.90 dB. Final kit transport lag 0 samples. Independent graph reference differed by at most ~0.5 PCM 16 LSB after export quantization.
- Disclosed FFmpeg afftdn settings on those same files scored 17.98/17.33 dB after 1200 sample transport alignment. Native filtering was substantially faster and uses a different algorithm; this is not a feature-equivalent speed competition or general quality verdict.
- Ten-minute mono raw streaming inference matched the independent whole-buffer output byte-for-byte (SHA-256 `17b6cd977e482d5e488b2961c10f4c5690ad08a3cbb91c583c284a3372daf17b`). Streaming child-tree peak ~164.5 MiB versus ~653.6 MiB. Inference times ~42.26/41.30 s. Streaming includes decoder I/O; the reference receives predecoded PCM. Complete kit decode/export/verification took~45.09 s.
- One-hour 16 kHz input preserved 57,600,000 output frames and 3600 seconds, finishing in ~269.15 s with ~177.2 MiB sampled child-tree peak and ~769.0 MiB temporary audio. This synthetic fixture checks duration/resources, not one-hour speech perceptual quality.
- 20 repeated denoise jobs left no processing scratch/staging. Supporting audit soak covered 100 jobs and a two-hour 16 kHz file with bounded complete-file charts.

All RAM values are 100 ms sampled RSS, not hard allocator ceilings. Temp disk scales with duration/channels. Two English audiobook excerpts/white noise do not establish performance across languages, reverberation, traffic/wind or all recording conditions.

## Failure ownership and delivery

The suite covers malformed/truncated/nonfinite media, limits, model tampering, zero-strength bypass, source/hardlink protection, output collisions, codec round trips, silent normalization, observer errors, per-job/batch cancellation, transient startup group-signalling errors, initialization/inference/normalization/export/verification abort, timeout, queued work and client close. Non-root container HTTP cancellation left 0 decoder processes, 0 inference workers and 0 private upload directories.

A container with network access disabled produced a denoised WAV. A 2 MiB tmpfs deliberately exhausted scratch space: OUTPUT_SPACE was returned and no partial output/scratch remained. These checks validate actual local operation and failure cleanup, not an API proxy.

Runtime and demo npm audits report 0 known vulnerabilities at verification time. Fresh installs test actual model initialization and output, not only import success. Schemas are generated from public types and checked for drift. The exact final tarball hash and installed consumer receipts accompany release-receipt.json/SHA256SUMS.

## Boundaries

The exact exported model release and initial-state arrays are now verified; the adopted MIT interpretation and remaining original training/author-confirmation limits are documented in provenance.md. Registry publication is recorded separately in its dated receipt. Physical-phone recording, full ITU certification and a representative speech-quality corpus are not asserted. The protected source inventory detected one unrelated shared website runtime change; it was left intact and not attributed to this isolated kit implementation.

## Initial public CI corrections — 13 October 2026

The first public run exposed a Windows file-sync error: a read-only staged-output handle could not be flushed. The corrected handle uses read/write access without truncating the verified audio. Fast Linux Node 24 processing also exposed a missing first progress event for clips finishing within the update interval. The first processed frame now always reports its phase. A one-sample regression cancels both denoising and conversion while preserving an existing destination and leaving no scratch files. A delayed-filesystem regression also proves that the scratch-open ordering fix preserves all decoder output: the original worker loses a513-frame clip after a500ms open delay, while the corrected worker exports all513frames. TypeScript consumer import paths are escaped for Windows. All94tests pass locally; the complete platform matrix and package consumers are rerun in public CI.

## npm publication preparation — 13 October 2026

The public package name, homepage, install instructions, runnable example imports and component records were updated for npm. Runtime source and pinned model bytes are unchanged. A separate release candidate receives fresh installed ESM/CommonJS/TypeScript and real CLI audio-processing checks; its dated receipts distinguish preparation, registry upload and actual registry installation. These packaging checks do not imply a renewed broad platform matrix.
