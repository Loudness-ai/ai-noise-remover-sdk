# Loudness.ai Audio Kit for Python

Remove noise, enhance speech, normalize loudness, convert audio and measure the result locally. This is a native Python SDK and command-line tool built from the existing Loudness.ai Audio Kit. Audio stays on the computer or server running it. Processing requires neither Node.js nor an API key nor a Loudness.ai server.

The package includes the same pinned CPU speech engine as the JavaScript edition. It processes the complete recording in small frames, preserves channel independence and verifies the exported file before publishing it. It also includes bounded scheduling, cancellation cleanup, configurable resource limits, measurements, policy checks, comparisons and offline reports.

## Install

Use Python 3.11–3.14 and a local FFmpeg/FFprobe installation with the required codecs and filters. On macOS, `brew install ffmpeg`; on Debian/Ubuntu, `sudo apt-get install ffmpeg`. These commands install system dependencies, not Python libraries.

Install from PyPI in a virtual environment:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install loudness-audio-kit
loudness-audio processing-doctor
```

The wheel contains the processing assets; runtime dependencies are installed by pip. `processing-doctor` exercises actual decoding, speech processing and export. `doctor` checks executable/filter availability only. The wheel tag refers to this package's Python code; its runtime dependencies contain platform-native binaries. The pinned runtime [requires Python 3.11 or newer](https://pypi.org/project/onnxruntime/1.30.0/).

The source distribution includes `DISTRIBUTION-LICENSE`, `NOTICE`, `docs/provenance.md` and the original component notices under `third-party`. These record the model's verified release source and distribution terms.

## Python

```python
from loudness_audio_kit import denoise, enhance, normalize, convert

denoise("recording.wav", "clean.wav")
enhance("podcast.mp3", "podcast-clean.wav", target_lufs=-16)
normalize("mix.wav", "mix-normalized.flac", target_lufs=-14, bit_depth=24)
convert("recording.m4a", "recording.opus", bitrate_kbps=128)
```

Output directories must already exist. Existing outputs are protected unless `overwrite=True` is deliberately supplied. An output cannot replace the input or a hard-link/symlink alias of it. Processing does not upload audio.

| Operation | Behavior |
| --- | --- |
| `denoise` | Local neural speech noise removal, with optional dry/processed `strength` blend |
| `enhance` | Speech noise removal, high-pass filtering, gentle compression and measured two-pass normalization |
| `normalize` | Measured two-pass loudness normalization without neural denoising |
| `convert` | Decode, resample/remix if requested and export without denoising or normalization by default |

`enhance(..., normalize=False, voice_processing=False)` disables the finishing stages. `denoise(..., strength=0)` keeps the decoded signal through the neural frame/timing path. Silent or ungated recordings skip normalization with a result warning. Measurement warnings report a missed loudness or true-peak target rather than silently claiming compliance.

## Command line

```sh
loudness-audio denoise recording.wav --output clean.wav --progress
loudness-audio enhance podcast.mp3 --output enhanced.wav --target-lufs -16
loudness-audio normalize mix.wav --output normalized.flac --bit-depth 24
loudness-audio convert recording.m4a --output recording.opus --bitrate-kbps 128
loudness-audio analyze enhanced.wav > analysis.json
loudness-audio example-policy > policy.json
loudness-audio validate enhanced.wav --policy policy.json
loudness-audio compare recording.wav enhanced.wav
loudness-audio report analysis.json --output report.html
```

`python -m loudness_audio_kit` is equivalent to `loudness-audio`. Results are finite JSON on stdout. `--progress` sends progress JSON to stderr. CLI option names use hyphens; SDK options and result keys use snake_case. Use `--help` for each command. Exit status: 0 success, 1 input/configuration/processing error, 2 failed policy/readiness or partially failed batch, 130 interrupted and cleaned up, 143 terminated and cleaned up.

## Files and configurable limits

Supported input containers include WAV, MP3, FLAC, M4A/MP4/MOV, AAC, OGG/Opus, WebM/Matroska and AIFF, subject to the installed decoder. Files with multiple audio tracks require an explicit absolute `stream_index`. Inputs support 1–8 channels and 8–192 kHz. WAV and FLAC exports support 16/24-bit and 1–8 channels; MP3 and Opus exports support mono/stereo. Source rate and channel count are preserved by default, except Opus uses a 48 kHz playback clock. MP3 sample rates must be supported by its codec. Speech processing runs internally at 48 kHz and compensates its frame delay, including the recording tail.

There is no remote upload limit. Developers set local admission limits through `Options`, function keywords or CLI flags:

| Option | Default | Meaning |
| --- | --- | --- |
| `max_file_bytes` | 10 GiB | Input file size |
| `max_duration_seconds` | 86,400 | Header and decoded-duration ceiling; configurable up to 7 days |
| `timeout_seconds` | 3,600 | Wall-clock budget for the whole operation, including queue wait |
| `max_temp_bytes` | 4 GiB | Temporary raw audio plus staged export budget |
| `memory_budget_mib` | 512 | Sampled owned child-process RSS ceiling |
| `native_threads` | 1 | Per-job native inference/decoder thread setting |
| `temp_directory` | OS temporary directory | Parent for private per-job scratch directories |
| `max_points` / `max_events` | 2,048 / 128 | Bounded measurement/report detail |

```python
from loudness_audio_kit import Options, enhance

limits = Options(
    max_file_bytes=200 * 1024**2,
    max_duration_seconds=3600,
    timeout_seconds=900,
    max_temp_bytes=2 * 1024**3,
    memory_budget_mib=384,
    temp_directory="/var/tmp/my-audio-jobs",
)
result = enhance("podcast.wav", "clean.wav", limits)
print(result["output"], result["metrics"])
```

Long recordings need enough scratch disk and time; limits are ceilings, not promises that every configuration can process a file. The raw intermediate is 32-bit PCM: denoising requires approximately `seconds × 48000 × channels × 4` bytes, plus the staged export. RSS is sampled every 100 ms; it is not an operating-system hard quota and excludes the calling Python process. Use container/service limits as an additional boundary. The source distribution includes the complete API and option reference in `docs/api.md`.

## Concurrent jobs and cancellation

```python
from loudness_audio_kit import AudioClient, AudioError

with AudioClient(
    concurrency=4,
    total_memory_budget_mib=2048,
    cpu_thread_budget=4,
    max_queued=100,
) as client:
    job = client.submit("input.wav", "output.wav", mode="denoise")
    # job.cancel() requests a stop; job.result() waits for physical cleanup.
    try:
        print(job.result()["output"])
    except AudioError as error:
        print(error.code)
```

Concurrency is configurable from 1 to 256, with memory/thread admission checks; the automatic default is bounded at eight. Set explicit budgets in containers and shared servers. `AudioFuture.cancel()` requests cancellation; a cancelled job raises `AudioError` with code `CANCELLED` from `result()` after its owned workers stop and private files are removed. It deliberately does not use the standard Future's immediately-cancelled state for a running operation. Queued cancellation settles immediately without starting processing. `close()` cancels and waits for jobs. Do not close a client from its own progress callback.

For asynchronous applications, `await process_audio_async(...)` keeps the event loop free and fences cleanup when the task is cancelled, including repeated cancellation. For a service's bounded shared queue, use one `AudioClient` and propagate request disconnects through `job.cancel()`. The source distribution includes lifecycle guidance in `docs/lifecycle.md` and working examples in `examples/batch.py` and `examples/async_processing.py`.

## Measurements and review

`inspect`, `analyze`, `validate`, `evaluate`, `compare`, `batch`, `process_batch`, `benchmark`, `check_report` and `render_report` are exported from `loudness_audio_kit`. Measurements include actual decoded duration, gated integrated loudness, true/sample peaks, RMS, DC offset, near-full-scale samples/runs, silence, channel balance/correlation, coarse band energy and bounded waveform/loudness data. Unavailable readings are `None`, not invented scores. Comparisons check timing and measured differences with bounded alignment windows; they do not establish listening quality.

Policies define delivery limits and how unavailable measurements should be treated. The benchmark runner records trusted local commands, fixture checksums, settings, timings and sampled resources. Benchmark manifests execute programs and must never come from untrusted users. Offline HTML reports escape their data and require no remote assets. The source distribution includes measurement guidance in `docs/measurements.md`.

## Development and verification

```sh
python -m pip install -e '.[dev]'
ruff check src tests scripts examples
ruff format --check src tests scripts examples
mypy src
pytest -q
python -m build
twine check dist/*
```

Download and extract the source distribution from this release's PyPI files to work on the package or read the included documentation. It contains verification evidence in `docs/verification.md`, release checks in `docs/release-checklist.md`, `SECURITY.md` and `CONTRIBUTING.md`. The speech samples retain their recorded credits and CC-BY-4.0 provenance. Wrapper code is MIT; `DISTRIBUTION-LICENSE` documents the upstream components and adopted licensing interpretation. Original DeepFilterNet and deepfilter-stream notices are included under `third-party`. Optional attribution such as “Audio processing with Loudness.ai Audio Kit” is welcome; no backlink requirement is added to the code license.
