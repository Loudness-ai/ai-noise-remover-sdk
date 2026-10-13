# Loudness.ai Audio Kit

Local speech noise removal, audio enhancement, loudness normalization and audio measurement for **Python, JavaScript and TypeScript**. Built by [Loudness.ai](https://loudness.ai/).

**Runs locally on CPU. No GPU or CUDA installation is required.** Audio stays on the computer or server running the kit. No Loudness.ai account, API key or hosted inference service is required. Both editions include the same pinned speech engine and produce complete audio files through their SDK and command-line interface.

[![Verify Audio Kit](https://github.com/secretheart49/loudness-audio-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/secretheart49/loudness-audio-kit/actions/workflows/ci.yml)
[![PyPI version](https://img.shields.io/pypi/v/loudness-audio-kit?label=PyPI)](https://pypi.org/project/loudness-audio-kit/)
[![Python versions](https://img.shields.io/pypi/pyversions/loudness-audio-kit)](https://pypi.org/project/loudness-audio-kit/)
[![Node.js versions](https://img.shields.io/badge/Node.js-22%20%7C%2024-339933?logo=nodedotjs&logoColor=white)](javascript/package.json)
[![Code license: MIT](https://img.shields.io/badge/Code%20license-MIT-blue)](LICENSE)

## What it does

| Operation | Result |
| --- | --- |
| Denoise | Remove background noise from voice recordings, with adjustable processing strength. |
| Enhance | Denoise speech, reduce low rumble, apply configurable voice compression and normalize loudness. |
| Normalize | Apply measured two-pass loudness and true-peak targets without neural denoising. |
| Convert | Export WAV, FLAC, MP3 or Opus, with optional resampling and channel changes. |
| Inspect, analyze and validate | Measure full recordings and check them against your delivery policy. |
| Compare and report | Compare recordings and create self-contained HTML or JSON reports. |
| Batch and schedule | Process ordered jobs with configurable concurrency, memory reservations and queue limits. |

The speech engine is designed for voice recordings. It can suppress intentional music and is not a stem separator or music mastering processor. Measurements and same-engine parity checks do not prove universal perceptual superiority.

## Choose an edition

| Edition | Runtime | Install and documentation |
| --- | --- | --- |
| Python | Python 3.11–3.14; FFmpeg/FFprobe | [Official PyPI project](https://pypi.org/project/loudness-audio-kit/) · [Python guide](python/README.md) |
| JavaScript / TypeScript | Node.js 22 or 24; FFmpeg/FFprobe | Build from this repository · [JavaScript guide](javascript/README.md) |

Both editions use CPU inference and include their processing assets. Python runs natively without Node.js; the JavaScript edition runs without Python.

## Use Python

Requires Python 3.11–3.14 and FFmpeg/FFprobe. Install FFmpeg with `brew install ffmpeg` on macOS or `sudo apt-get install ffmpeg` on Debian/Ubuntu.

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install loudness-audio-kit
loudness-audio processing-doctor
loudness-audio enhance recording.wav --output enhanced.wav --progress
```

On Windows, activate the environment with `.venv\Scripts\activate`.

```python
from loudness_audio_kit import denoise, enhance

denoise("interview.wav", "clean.flac", strength=0.8)
enhance("podcast.mp3", "enhanced.wav", target_lufs=-16)
```

[Python guide](python/README.md) · [API and options](python/docs/api.md) · [Cancellation and scheduling](python/docs/lifecycle.md) · [Examples](python/examples)

## Build the JavaScript and TypeScript edition

Requires Node.js 22 or 24 and FFmpeg/FFprobe.

```sh
git clone https://github.com/secretheart49/loudness-audio-kit.git
cd loudness-audio-kit/javascript
npm ci --ignore-scripts
npm run build
node dist/cjs/cli.js processing-doctor
node dist/cjs/cli.js enhance recording.wav --output enhanced.wav --progress
```

The source examples use the package's ESM or CommonJS exports:

```js
import { denoise, enhance } from 'loudness-audio-kit';

await denoise('interview.wav', 'clean.flac', { strength: 0.8 });
await enhance('podcast.mp3', 'enhanced.wav', { targetLufs: -16 });
```

Run a bundled example after building:

```sh
node examples/process.mjs recording.wav enhanced.wav
```

[JavaScript guide](javascript/README.md) · [API and options](javascript/docs/api.md) · [Architecture](javascript/docs/architecture.md) · [Examples](javascript/examples/README.md)

## Limits and cancellation

Both SDKs accept local WAV, MP3, FLAC, M4A/MP4, AAC, OGG, Opus, WebM and AIFF recordings, subject to the installed decoder. Developers control file size, decoded duration, deadlines, scratch space, native threads and memory admission. SDK defaults include a 10 GiB input limit, 24-hour duration ceiling and 4 GiB scratch budget; all limits apply together. Concurrency can be configured from 1 to 256 jobs when the host has the necessary reserved resources.

Processing streams bounded frames rather than retaining a full recording in RAM. Scratch disk grows with recording duration. Memory readings are sampled thresholds, not hard operating-system quotas. Cancellation stops owned workers and decoder/encoder processes before releasing resources, and removes private scratch files. Existing input and destination files are protected; overwrite requires an explicit option.

The Python and JavaScript guides document their individual option names, result fields and exit codes. Their APIs are native to each language, rather than one edition launching the other.

## Local web demo

From `javascript/`:

```sh
npm ci --prefix demo --ignore-scripts
npm run demo
```

Open `http://127.0.0.1:7860/` to upload, process, preview and download audio locally. The demo defaults to 25 MiB and five minutes per file; its admission and resource limits are configurable. A non-root Docker setup is included in [the demo guide](javascript/demo/README.md).

```sh
# From javascript/
docker build -f demo/Dockerfile -t loudness-audio-kit .
docker run --rm -p 7860:7860 loudness-audio-kit
```

## Verification and contributing

Tests exercise actual speech inference, export, full recording tails, independent channels, normalization, cancellation, resource limits and failures. See the dated [JavaScript verification ledger](javascript/docs/verification.md) and [Python verification ledger](python/docs/verification.md) for executed platforms and the limits of the evidence. GitHub Actions results are available through the badge above.

[Contributing](CONTRIBUTING.md) · [Security reporting](SECURITY.md)

## License and attribution

Loudness.ai’s SDK, CLI, scheduling, reports and demo code is MIT. Bundled model assets, native dependencies and credited recordings retain their separate component terms. Read [distribution terms](DISTRIBUTION-LICENSE), each edition's notices and provenance records before redistribution. Original upstream license texts are included in both editions.

Credit is welcome and optional:

> Audio processing powered by [Loudness.ai Audio Kit](https://loudness.ai/).

Attribution or a website link is not an additional condition of the MIT code license.
