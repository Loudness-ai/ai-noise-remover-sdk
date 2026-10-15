# AI Noise Remover SDK for JavaScript and TypeScript

The Node.js edition of the [AI Noise Remover SDK](https://loudness.ai/developers/ai-noise-remover-sdk/) (formerly the Loudness.ai Audio Kit).

Local speech noise removal, audio enhancement, loudness normalization and format export for Node.js developers. It also measures recordings, validates delivery settings, compares outputs and benchmarks processors.

**Runs locally on CPU. No GPU or CUDA installation is required.** The kit produces processed audio on your own computer or server, with no Loudness.ai account, API key, paid endpoint or network connection during processing. The web demo uses the same library on the machine hosting that demo.

[![PyPI version](https://img.shields.io/pypi/v/loudness-audio-kit?label=Python%20edition)](https://pypi.org/project/loudness-audio-kit/)
[![Verify AI Noise Remover SDK](https://github.com/Loudness-ai/ai-noise-remover-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/Loudness-ai/ai-noise-remover-sdk/actions/workflows/ci.yml)

## Build from GitHub

```sh
git clone https://github.com/Loudness-ai/ai-noise-remover-sdk.git
cd ai-noise-remover-sdk/javascript
npm ci --ignore-scripts
npm run build
node dist/cjs/cli.js processing-doctor
node dist/cjs/cli.js enhance recording.wav --output enhanced.wav --progress
```

## Package installation

Requirements: Node.js 22 or 24 and a local FFmpeg/FFprobe installation. FFmpeg must provide `ebur128`, `loudnorm`, `highpass`, `acompressor`, and the codecs you select. The pinned CPU speech assets are included in the package; no model is downloaded at runtime.

```sh
npm install loudness-audio-kit
npx loudness-audio processing-doctor
npx loudness-audio enhance recording.wav --output enhanced.wav --progress
npx loudness-audio denoise recording.mp3 --output clean.wav
```

Built by [Loudness.ai](https://loudness.ai/). The native Python edition is available on [PyPI](https://pypi.org/project/loudness-audio-kit/).

`doctor` checks native dependencies; `processing-doctor` additionally exercises the installed local speech graph through a real decode, inference and WAV export.

## JavaScript and TypeScript

```js
import { enhance, denoise } from 'loudness-audio-kit';

const result = await enhance('recording.m4a', 'enhanced.wav', {
  targetLufs: -16,
  truePeakDbtp: -1.5,
  bitDepth: 24,
});
console.log(result.output, result.analysis.integratedLufs, result.warnings);

await denoise('interview.wav', 'clean.flac', { strength: 0.8 });
```

CommonJS works too: `const { enhance } = require('loudness-audio-kit')`.

| Operation | What it does |
| --- | --- |
| `denoise` | Removes background noise from speech with the pinned local CPU engine. Preserves level unless normalization is requested. |
| `enhance` | Denoises speech, reduces low rumble, applies gentle voice compression, then prepares a measured loudness/true-peak target. Each preparation stage is configurable. |
| `normalize` | Two-pass measured loudness normalization without neural denoising. |
| `convert` | Decodes and exports audio without neural denoising. Supports explicit resampling and channel changes. |
| `analyze`, `inspect`, `validate`, `compare` | Full-recording measurements, delivery checks and before/after diagnostics. |
| `processBatch`, `createAudioClient` | Ordered batch jobs or shared bounded scheduling across application requests. |

The speech engine is intended for voice recordings. It can suppress intentional music or sound effects; enhancement is not source separation or a music mastering algorithm. `strength: 0` bypasses neural processing. Existing source files are never overwritten.

## File types and adjustable limits

Inputs: WAV, MP3, FLAC, M4A/MP4, AAC, OGG/Vorbis, Opus, WebM/Matroska and AIFF, subject to the installed decoder's codecs. Select an absolute audio `streamIndex` when a container has multiple audio tracks. Remote URLs, playlists and concat inputs are rejected.

Output: WAV (16/24-bit), FLAC (16/24-bit), MP3 and Opus. Source sample rate and channel count are preserved by default; Opus uses a 48 kHz clock, and MP3/Opus exports require mono or stereo. Lossless processing supports 1–8 channels at 8–192 kHz. Each speech channel has independent recurrent state.

| Setting | SDK/CLI default | Override |
| --- | --- | --- |
| Input size | 10 GiB | `maxFileBytes` / `--max-bytes` |
| Actual decoded duration | 24 hours | `maxDurationSeconds` / `--max-duration` (up to 7 days) |
| Whole operation deadline | 1 hour | `timeoutMs` / `--timeout-ms` |
| Temporary audio budget | 4 GiB | `maxTempBytes` / `--max-temp-bytes` |
| Sampled child process memory budget | 512 MiB per job | `memoryBudgetMiB` / `--memory-mib` |
| Native threads | 1 per job | `nativeThreads` / `--native-threads` |

All limits apply together. A 24-hour duration allowance does not promise that a 4 GiB scratch budget fits that file. Denoising uses approximately `seconds × 48000 × channels × 4` bytes of raw scratch audio plus its staged export. RAM does not grow with recording duration; scratch disk does. RSS is sampled every 100 ms and is a stop threshold, not a hard operating-system allocation cap. Use container/OS quotas for strict memory or disk isolation.

There is no fixed one- or two-worker ceiling. Explicit concurrency supports 1–256 jobs, with admission checked against your memory and thread reservations. Set limits for the actual host capacity.

```js
import { createAudioClient } from 'loudness-audio-kit';
const client = createAudioClient({
  concurrency: 6,
  memoryBudgetMiB: 512,
  totalMemoryBudgetMiB: 3072,
  maxNativeThreads: 6,
  maxQueued: 100,
});
const controller = new AbortController();
try {
  await client.enhance('voice.wav', 'voice-clean.wav', {
    signal: controller.signal,
    maxDurationSeconds: 7200,
    timeoutMs: 900000,
  });
} finally {
  await client.close();
}
```

Deadlines include queued time. Abort or `close()` stops owned inference/decoder/encoder process groups and waits for cleanup; no partial output is published. Temporary audio is deleted before the final atomic output commit. Cancellation after that commit cannot retract a completed file. Existing destinations require `overwrite: true` / `--overwrite`; source aliases and batch destination collisions are rejected.

## More commands

```sh
loudness-audio enhance voice.wav --output voice.mp3 --bitrate 192 --target-lufs -18 --true-peak -2
loudness-audio enhance voice.wav --output clean.wav --no-normalize --no-voice-processing
loudness-audio normalize podcast.wav --output normalized.flac --target-lufs -16
loudness-audio convert input.m4a --output output.wav --sample-rate 44100 --channels 2
loudness-audio process-batch jobs.json --concurrency 6 --total-memory-mib 3072 --json
loudness-audio analyze voice.wav --json --html measurements.html
loudness-audio validate voice.wav --policy examples/policy.json --json
loudness-audio compare original.wav enhanced.wav --json
```

JSON is on stdout; progress is on stderr. Exit codes: 0 success, 2 configured audit policy failure, 3 invalid invocation, 4 processing/batch failure, 124 timeout, 130 cancellation. `audio-audit` is a compatibility alias. Use `loudness-audio enhance --help` for processing options. See API and limits (`docs/api.md`), architecture and cleanup (`docs/architecture.md`), measurements (`docs/measurements.md`) and runnable examples (`examples/README.md`).

## Bundled examples and verification

The installed package includes runnable SDK, batch, HTTP-service and cancellation examples under `node_modules/loudness-audio-kit/examples`. The API reference, architecture, measurements and executed verification record are included under `node_modules/loudness-audio-kit/docs`.

```sh
node node_modules/loudness-audio-kit/examples/process.mjs recording.wav enhanced.wav
node node_modules/loudness-audio-kit/examples/analyze.mjs recording.wav measurements.html
```

The complete source distribution also contains the local web demo, tests and non-root Docker/Hugging Face setup. That demo uses this same library to return actual WAV audio, playback, downloads and measurements. Its upload limits are independent configurable defaults (25 MiB, five minutes); disconnecting or cancelling removes private audio after owned work stops. Those source-only development tools are separate from the installable npm runtime.

Two audiobook fixtures with added noise provide regression evidence, not proof of universal superiority. The bundled verification ledger records the executed platform checks and measured quality/performance.

## License and credit

Loudness.ai wrapper code is MIT. Distribution terms (`DISTRIBUTION-LICENSE`) describe the separate component records; verbatim upstream code licenses are included in `third-party/DeepFilterNet`. Native dependencies, pretrained assets and recordings have their own terms; provenance (`docs/provenance.md`) identifies these separately. The exact model export source and adopted MIT interpretation are recorded there; no separate original-author weight-scope confirmation is claimed. Optional credit is welcome:

```markdown
Audio processing powered by [AI Noise Remover SDK by Loudness.ai](https://loudness.ai/developers/ai-noise-remover-sdk/).
```

README branding or a backlink is optional, not an added MIT license condition.
