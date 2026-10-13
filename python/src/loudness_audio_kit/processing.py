"""Local processing with verified, atomic publication."""

import asyncio
import json
import math
import os
import re
import shutil
import stat
import sys
import tempfile
import time
import uuid
from dataclasses import replace
from pathlib import Path
from typing import Any

from ._process import run, translate_os_error
from .analysis import analyze
from .errors import AudioError, CancellationToken
from .inspection import assert_source, inspect, local_path, source_file
from .options import Context, Json, Options, notify, options_for

MODES = ("denoise", "enhance", "normalize", "convert")
FORMATS = ("wav", "flac", "mp3", "opus")


def destination_for(source: Path, destination: str | os.PathLike[str], overwrite: bool) -> Path:
    path = local_path(destination, "OUTPUT_INVALID")
    try:
        parent = path.parent.resolve(strict=True)
        if not parent.is_dir():
            raise OSError()
    except OSError as exc:
        raise AudioError("OUTPUT_DIRECTORY", "The output directory does not exist.") from exc
    path = parent / path.name
    if path == source:
        raise AudioError("OUTPUT_CLOBBER", "Output must not replace the source recording.")
    try:
        info = path.lstat()
    except FileNotFoundError:
        return path
    except OSError as exc:
        raise translate_os_error(exc) from exc
    if not stat.S_ISREG(info.st_mode):
        raise AudioError(
            "OUTPUT_INVALID", "Output must be a regular file destination, not a symlink."
        )
    try:
        s = source.stat()
    except OSError as exc:
        raise AudioError("INPUT_CHANGED", "The source recording is no longer readable.") from exc
    if (info.st_dev, info.st_ino) == (s.st_dev, s.st_ino):
        raise AudioError(
            "OUTPUT_CLOBBER", "Output must not replace an alias of the source recording."
        )
    if not overwrite:
        raise AudioError("OUTPUT_EXISTS", "Output exists; enable overwrite deliberately.")
    return path


def codec(format_: str, opt: Options) -> list[str]:
    if format_ == "wav":
        return [
            "-c:a",
            "pcm_s24le" if opt.bit_depth == 24 else "pcm_s16le",
            "-f",
            "wav",
            "-rf64",
            "auto",
        ]
    if format_ == "flac":
        return [
            "-c:a",
            "flac",
            "-sample_fmt",
            "s32" if opt.bit_depth == 24 else "s16",
            "-f",
            "flac",
        ]
    return [
        "-c:a",
        "libmp3lame" if format_ == "mp3" else "libopus",
        "-b:a",
        f"{opt.bitrate_kbps}k",
        "-f",
        format_,
    ]


def process_audio(
    file: str | os.PathLike[str],
    output: str | os.PathLike[str],
    mode: str = "enhance",
    options: Options | None = None,
    *,
    _context: Context | None = None,
    **kwargs: Any,
) -> Json:
    opt = options_for(options, **kwargs)
    if mode not in MODES:
        raise AudioError("CONFIG_INVALID", "Unsupported processing mode.")
    context = _context or Context(opt)
    started = time.monotonic()
    source, identity = source_file(file, opt, context)
    target = destination_for(source, output, opt.overwrite)
    format_ = opt.format or target.suffix[1:].lower()
    if format_ not in FORMATS:
        raise AudioError("CONFIG_INVALID", "Choose WAV, FLAC, MP3 or Opus output.")
    info = inspect(source, opt, _context=context)
    stream = info["selected_stream"]
    channels = opt.channels or stream["channels"]
    sample_rate = 48000 if format_ == "opus" else opt.sample_rate or stream["sample_rate"]
    if format_ == "opus" and opt.sample_rate not in (None, 48000):
        raise AudioError("CONFIG_INVALID", "Opus exports use a 48000 Hz playback clock.")
    if format_ in ("mp3", "opus") and channels > 2:
        raise AudioError(
            "CONFIG_INVALID",
            "MP3 and Opus exports require mono or stereo; select channels explicitly.",
        )
    if format_ == "mp3" and sample_rate not in (
        8000,
        11025,
        12000,
        16000,
        22050,
        24000,
        32000,
        44100,
        48000,
    ):
        raise AudioError("CONFIG_INVALID", "Choose a supported MP3 sample rate explicitly.")
    neural = mode in ("denoise", "enhance")
    working_rate = 48000 if neural else sample_rate
    strength = opt.strength if neural else 0
    normalized = mode == "normalize" or (
        opt.normalize if opt.normalize is not None else mode == "enhance"
    )
    voice_processing = mode == "enhance" and opt.voice_processing
    scratch: Path | None = None
    staged: Path | None = None
    measurements: list[Json] = []
    warnings: list[str] = []
    try:
        scratch = Path(tempfile.mkdtemp(prefix="loudness-audio-", dir=opt.temp_directory))
        raw = scratch / "clean.f32"
        staged = target.parent / f".loudness-audio-{uuid.uuid4().hex}.tmp"
        fd = os.open(staged, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        config = {
            "input": str(source),
            "output": str(raw),
            "ffmpeg": opt.ffmpeg_path,
            "stream_index": stream["index"],
            "model_dir": str(
                Path(opt.model_dir).resolve()
                if opt.model_dir
                else Path(__file__).parent / "models" / "dfn3-512-v1"
            ),
            "channels": channels,
            "sample_rate": working_rate,
            "threads": opt.native_threads,
            "max_duration": opt.max_duration_seconds,
            "max_temp_bytes": opt.max_temp_bytes,
            "declared_duration": info["declared_duration_seconds"],
            "neural": neural,
            "strength": strength,
        }
        config_path = scratch / "job.json"
        config_path.write_text(json.dumps(config, allow_nan=False))
        os.chmod(config_path, 0o600)
        worker_result: Json | None = None
        worker_error: Json | None = None

        def worker_line(line: str) -> None:
            nonlocal worker_result, worker_error
            try:
                value = json.loads(line)
            except ValueError:
                return
            if value.get("kind") == "worker-result":
                worker_result = value
            elif value.get("kind") == "worker-error":
                worker_error = value
            elif value.get("phase") in ("initialize", "denoise", "decode"):
                notify(
                    opt,
                    value["phase"],
                    value.get("fraction"),
                    **(
                        {"decoded_seconds": value["decoded_seconds"]}
                        if "decoded_seconds" in value
                        else {}
                    ),
                )

        try:
            worker = run(
                sys.executable,
                ["-m", "loudness_audio_kit._worker", str(config_path)],
                opt,
                context,
                on_stdout_line=worker_line,
                temp_paths=(raw, staged),
            )
        except AudioError as exc:
            if worker_error and exc.code == "PROCESS_FAILED":
                raise AudioError(worker_error["code"], worker_error["message"]) from exc
            raise
        measurements.append(worker["metrics"])
        if (
            not worker_result
            or type(worker_result.get("frames")) is not int
            or worker_result["frames"] <= 0
        ):
            raise AudioError(
                "OUTPUT_INVALID", "The speech processor did not return a complete recording."
            )
        duration = worker_result["frames"] / working_rate
        raw_bytes = raw.stat().st_size
        if raw_bytes != worker_result["frames"] * channels * 4:
            raise AudioError(
                "OUTPUT_INVALID", "The processed raw audio has an unexpected byte count."
            )
        if raw_bytes >= opt.max_temp_bytes:
            raise AudioError(
                "TEMP_LIMIT", "The temporary budget cannot fit this recording and its export."
            )
        raw_args = ["-f", "f32le", "-ar", str(working_rate), "-ac", str(channels)]
        if opt.channels is None and stream["channel_layout"]:
            raw_args += ["-channel_layout", stream["channel_layout"]]
        raw_args += ["-i", str(raw)]
        filters = (
            ["highpass=f=80", "acompressor=threshold=0.125:ratio=2:attack=10:release=150:makeup=1"]
            if voice_processing
            else []
        )
        normalization_applied = bool(normalized)
        base = ["-nostdin", "-threads", str(opt.native_threads), "-filter_threads", "1"]
        loudnorm = (
            f"loudnorm=I={opt.target_lufs}:TP={opt.true_peak_dbtp}:LRA={opt.loudness_range_lu}"
        )
        if normalized:
            notify(opt, "normalize")
            measured_run = run(
                opt.ffmpeg_path,
                [
                    *base,
                    "-v",
                    "info",
                    *raw_args,
                    "-af",
                    ",".join([*filters, loudnorm + ":print_format=json"]),
                    "-f",
                    "null",
                    "-",
                ],
                opt,
                context,
                temp_paths=(raw, staged),
            )
            measurements.append(measured_run["metrics"])
            block = re.search(r'\{\s*"input_i"[\s\S]*?\}', measured_run["stderr"])
            if not block:
                raise AudioError(
                    "NORMALIZATION_FAILED", "Could not measure audio for normalization."
                )
            measured = json.loads(block[0])
            keys = ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")
            if not all(math.isfinite(float(measured[k])) for k in keys):
                normalization_applied = False
                warnings.append(
                    "Normalization was skipped because the recording has no measurable gated loudness."
                )
            else:
                filters.append(
                    loudnorm
                    + f":measured_I={measured['input_i']}:measured_TP={measured['input_tp']}:measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}:offset={measured['target_offset']}:linear=true"
                )
        notify(opt, "export", 0)

        def export_line(line: str) -> None:
            key, _, value = line.partition("=")
            if (
                key == "total_size"
                and value.isdigit()
                and int(value) + raw_bytes > opt.max_temp_bytes
            ):
                raise AudioError(
                    "TEMP_LIMIT", "The audio export exceeds the temporary-disk budget."
                )
            if key == "out_time_us" and re.fullmatch(r"-?\d+", value):
                notify(opt, "export", max(0, min(0.99, int(value) / 1e6 / duration)))

        encoded = run(
            opt.ffmpeg_path,
            [
                *base,
                "-v",
                "error",
                "-y",
                *raw_args,
                *(["-af", ",".join(filters)] if filters else []),
                "-map_metadata",
                "-1",
                "-ar",
                str(sample_rate),
                "-ac",
                str(channels),
                *codec(format_, opt),
                "-progress",
                "pipe:1",
                str(staged),
            ],
            opt,
            context,
            on_stdout_line=export_line,
            temp_paths=(raw, staged),
        )
        measurements.append(encoded["metrics"])
        output_bytes = staged.stat().st_size
        if not output_bytes or output_bytes + raw_bytes > opt.max_temp_bytes:
            raise AudioError("TEMP_LIMIT", "The audio export exceeds the temporary-disk budget.")
        notify(opt, "verify")
        analysis = analyze(
            staged,
            replace(
                opt,
                stream_index=None,
                max_file_bytes=max(opt.max_file_bytes, output_bytes),
                on_progress=None,
            ),
            _context=context,
        )
        out_stream = analysis["input"]["selected_stream"]
        if (
            out_stream["channels"] != channels
            or out_stream["sample_rate"] != sample_rate
            or abs(analysis["duration_seconds"] - duration)
            > (0.06 if format_ == "mp3" else 2 / sample_rate)
        ):
            raise AudioError(
                "OUTPUT_INVALID", "The exported audio has unexpected timing, rate or channels."
            )
        if (
            normalized
            and analysis["integrated_lufs"] is not None
            and abs(analysis["integrated_lufs"] - opt.target_lufs) > 0.5
        ):
            warnings.append("The output did not reach the requested loudness within 0.5 LU.")
        if (
            normalized
            and analysis["true_peak_dbtp"] is not None
            and analysis["true_peak_dbtp"] > opt.true_peak_dbtp + 0.2
        ):
            warnings.append(
                "Decoded output exceeds the true-peak target; choose lossless export or a lower target."
            )
        assert_source(source, identity)
        context.check()
        with staged.open("rb") as handle:
            os.fsync(handle.fileno())
        shutil.rmtree(scratch)
        scratch = None
        destination_for(source, target, opt.overwrite)
        context.check()
        if opt.overwrite:
            os.replace(staged, target)
        else:
            try:
                os.link(staged, target)
            except FileExistsError as exc:
                raise AudioError(
                    "OUTPUT_EXISTS", "Another job created the output destination."
                ) from exc
            staged.unlink()
        staged = None
        analysis["input"]["file"]["name"] = target.name
        peaks = [
            m["sampled_peak_tree_rss_bytes"]
            for m in measurements
            if m["sampled_peak_tree_rss_bytes"] is not None
        ]
        result = {
            "schema_version": 1,
            "kind": "processing",
            "mode": mode,
            "input": info,
            "output": {
                "path": str(target),
                "name": target.name,
                "size_bytes": output_bytes,
                "format": format_,
                "sample_rate": sample_rate,
                "channels": channels,
                "duration_seconds": analysis["duration_seconds"],
            },
            "settings": {
                "strength": strength,
                "voice_processing": voice_processing,
                "normalized": normalization_applied,
                "target_lufs": opt.target_lufs if normalized else None,
                "true_peak_dbtp": opt.true_peak_dbtp if normalized else None,
            },
            "analysis": analysis,
            "warnings": warnings,
            "metrics": {
                "wall_ms": (time.monotonic() - started) * 1000,
                "initialized_ms": worker_result["initialized_ms"],
                "inference_wall_ms": worker_result["wall_ms"],
                "sampled_peak_tree_rss_bytes": max(peaks) if peaks else None,
                "sampling_interval_ms": 100,
                "temporary_audio_bytes": raw_bytes + output_bytes,
                "memory_method": "psutil sampled owned child trees; Python caller and its bounded measurements excluded",
            },
        }
        # Publication is the commit point; a notification cannot turn success into failure.
        try:
            notify(opt, "complete", 1)
        except AudioError:
            pass
        return result
    except OSError as exc:
        raise translate_os_error(exc) from exc
    finally:
        if staged is not None:
            staged.unlink(missing_ok=True)
        if scratch is not None:
            shutil.rmtree(scratch)


def denoise(
    file: str | os.PathLike[str],
    output: str | os.PathLike[str],
    options: Options | None = None,
    **kwargs: Any,
) -> Json:
    return process_audio(file, output, "denoise", options, **kwargs)


def enhance(
    file: str | os.PathLike[str],
    output: str | os.PathLike[str],
    options: Options | None = None,
    **kwargs: Any,
) -> Json:
    return process_audio(file, output, "enhance", options, **kwargs)


def normalize(
    file: str | os.PathLike[str],
    output: str | os.PathLike[str],
    options: Options | None = None,
    **kwargs: Any,
) -> Json:
    return process_audio(file, output, "normalize", options, **kwargs)


def convert(
    file: str | os.PathLike[str],
    output: str | os.PathLike[str],
    options: Options | None = None,
    **kwargs: Any,
) -> Json:
    return process_audio(file, output, "convert", options, **kwargs)


async def process_audio_async(
    file: str | os.PathLike[str],
    output: str | os.PathLike[str],
    mode: str = "enhance",
    options: Options | None = None,
    **kwargs: Any,
) -> Json:
    opt = options_for(options, **kwargs)
    token = CancellationToken((opt.cancel_token,) if opt.cancel_token else ())
    task = asyncio.create_task(
        asyncio.to_thread(process_audio, file, output, mode, replace(opt, cancel_token=token))
    )
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        token.cancel()
        # Cancellation does not abandon a live worker. Repeated task.cancel() is fenced too.
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                continue
            except AudioError:
                break
        if task.done() and not task.cancelled():
            task.exception()
        raise
