"""Separate dependency diagnostics from actual processing readiness."""

import tempfile
import time
import wave
from dataclasses import replace
from pathlib import Path
from typing import Any

from ._process import run
from .errors import AudioError
from .options import Context, Json, Options, options_for
from .processing import denoise


def doctor(
    options: Options | None = None, *, _context: Context | None = None, **kwargs: Any
) -> Json:
    opt = options_for(options, **kwargs)
    context = _context or Context(opt)
    versions, errors = {}, []
    for name, executable in (("ffmpeg", opt.ffmpeg_path), ("ffprobe", opt.ffprobe_path)):
        try:
            result = run(executable, ["-version"], opt, context)
            versions[name] = result["stdout"].decode().splitlines()[0]
        except AudioError as exc:
            if exc.code in ("CANCELLED", "TIMEOUT"):
                raise
            errors.append(f"{name}: {exc.code}")
    if "ffmpeg" in versions:
        try:
            filters = run(opt.ffmpeg_path, ["-hide_banner", "-filters"], opt, context)[
                "stdout"
            ].decode()
            for name in ("ebur128", "loudnorm", "highpass", "acompressor"):
                if name not in filters:
                    errors.append(f"Required filter unavailable: {name}")
        except AudioError as exc:
            if exc.code in ("CANCELLED", "TIMEOUT"):
                raise
            errors.append(exc.code)
    return {"ready": not errors, "versions": versions, "errors": errors}


def processing_doctor(options: Options | None = None, **kwargs: Any) -> Json:
    opt = options_for(options, **kwargs)
    context = Context(opt)
    result = doctor(opt, _context=context)
    if result["ready"]:
        try:
            with tempfile.TemporaryDirectory(
                prefix="loudness-doctor-", dir=opt.temp_directory
            ) as directory:
                source = Path(directory) / "silence.wav"
                with wave.open(str(source), "wb") as recording:
                    recording.setparams((1, 2, 48000, 0, "NONE", "not compressed"))
                    recording.writeframes(b"\0" * 48000)
                context.check()
                denoise(
                    source,
                    Path(directory) / "processed.wav",
                    replace(
                        opt,
                        max_file_bytes=max(opt.max_file_bytes, source.stat().st_size),
                        timeout_seconds=max(0.001, context.deadline - time.monotonic()),
                    ),
                )
            result["speech_engine"] = "ready"
        except AudioError as exc:
            if exc.code in ("CANCELLED", "TIMEOUT"):
                raise
            result["errors"].append(exc.code)
            result["ready"] = False
            result["speech_engine"] = "unavailable"
    else:
        result["speech_engine"] = "unavailable"
    return result
