---
title: Loudness.ai Audio Kit
emoji: 🎧
colorFrom: gray
colorTo: red
sdk: docker
app_port: 7860
pinned: false
---

# Loudness.ai Audio Kit demo

Remove background noise or enhance a voice recording, play the resulting WAV and download the actual processed audio. Measurement, delivery-setting checks and before/after comparison are available too. The same local Node library powers the CLI and this demonstration; there is no hosted Loudness.ai inference API.

Default inputs: one audio stream, up to 25 MiB and five minutes per file. The SDK's own defaults are different and configurable. Uploaded audio is stored in a private temporary directory, processed on the demo host, and deleted after delivery, cancellation or failure. Returned summaries contain no private paths. The downloadable kit processes on the developer's own computer/server.

Run from the repository root with Node 22/24 and FFmpeg/FFprobe:

```sh
npm ci --ignore-scripts
npm run build
npm ci --prefix demo --ignore-scripts
npm run demo
# http://127.0.0.1:7860/
docker build -f demo/Dockerfile -t loudness-audio-kit .
docker run --rm -p 7860:7860 loudness-audio-kit
```

The Docker image runs as a non-root user with an init process and no development dependencies. For a Docker Space, use the prepared Hugging Face source archive: its root README has the Space frontmatter and its root Dockerfile points to this server.

| Environment variable | Default |
| --- | --- |
| HOST / PORT | 127.0.0.1 / 7860 (container0.0.0.0) |
| AUDIO_CONCURRENCY | Capacity-based auto admission |
| AUDIO_JOB_MEMORY_MIB | 512 |
| AUDIO_TOTAL_MEMORY_MIB | Capacity-based auto reservation |
| AUDIO_MAX_REQUESTS | 8 |
| AUDIO_MAX_FILE_BYTES | 26214400 |
| AUDIO_MAX_DURATION_SECONDS | 300 |
| AUDIO_TIMEOUT_MS | 120000 |
| AUDIO_REQUEST_TIMEOUT_MS | 150000 |
| AUDIO_MAX_TEMP_BYTES | 1073741824 |

Choose concurrency, queue/request admission and memory budgets for the actual host. The UI retrieves upload limits from the server. Limits are validated server-side. The custom request header/same-origin policy and bounded multipart parsing are retained. For public hosting, add an appropriate ingress HTTPS/request limit/rate control and monitor storage. The kit does not include an authentication/billing service.

The example is narration A with deterministic added noise: Garth Comira reading Ashiel Mystery chapter 2, CC-BY-4.0 via LibriSpeech/LibriVox. Full credit/source/checksums are in `examples/fixtures/provenance.json`; generation is in `scripts/processing-evidence.mjs`. The separate calibrated tone is CC0-1.0.

Wrapper code is MIT. Public distribution of the exact bundled speech weights requires the provenance/license check in `docs/provenance.md`; this README does not assign the wrapper's license to the pretrained model. Nothing has been uploaded to Hugging Face by preparing this archive.
