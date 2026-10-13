"""Local-media allowlist and stable file identity."""

import json
import math
import os
import re
import stat
from pathlib import Path
from typing import Any

from ._process import run
from .errors import AudioError
from .options import Context, Json, Options, notify, options_for

MEDIA_FORMATS = "wav,mp3,flac,mov,aac,ogg,matroska,webm,aiff"


def local_path(value: str | os.PathLike[str], code: str) -> Path:
    try:
        text = os.fspath(value)
        if (
            not isinstance(text, str)
            or not text
            or "\0" in text
            or re.match(r"^[a-z][a-z0-9+.-]*://", text, re.I)
        ):
            raise ValueError()
        return Path(text).absolute()
    except (TypeError, ValueError) as exc:
        raise AudioError(code, "Provide a local file path.") from exc


def signature(path: Path) -> tuple[int, int, int, int, int]:
    s = path.stat()
    return s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns


def source_file(
    value: str | os.PathLike[str], options: Options, context: Context
) -> tuple[Path, tuple[int, int, int, int, int]]:
    context.check()
    path = local_path(value, "INPUT_INVALID")
    try:
        path = path.resolve(strict=True)
        s = path.stat()
        if not stat.S_ISREG(s.st_mode) or s.st_size == 0:
            raise AudioError("INPUT_INVALID", "Input must be a nonempty regular file.")
        if s.st_size > options.max_file_bytes:
            raise AudioError("FILE_LIMIT", "The file exceeds the configured byte limit.")
        with path.open("rb"):
            pass
        return path, signature(path)
    except OSError as exc:
        raise AudioError("INPUT_UNREADABLE", "Could not read the input file.") from exc


def assert_source(path: Path, expected: tuple[int, int, int, int, int]) -> None:
    try:
        unchanged = signature(path) == expected
    except OSError:
        unchanged = False
    if not unchanged:
        raise AudioError("INPUT_CHANGED", "The source recording changed during processing.")


def positive_duration(value: Any) -> float | None:
    try:
        n = float(value)
        return n if math.isfinite(n) and n > 0 else None
    except (TypeError, ValueError):
        return None


def inspect(
    file: str | os.PathLike[str],
    options: Options | None = None,
    *,
    _context: Context | None = None,
    **kwargs: Any,
) -> Json:
    opt = options_for(options, **kwargs)
    context = _context or Context(opt)
    path, identity = source_file(file, opt, context)
    notify(opt, "inspect")
    try:
        result = run(
            opt.ffprobe_path,
            [
                "-v",
                "error",
                "-protocol_whitelist",
                "file,pipe",
                "-format_whitelist",
                MEDIA_FORMATS,
                "-show_entries",
                "stream=index,codec_type,codec_name,sample_rate,channels,channel_layout,duration:stream_tags=language:format=format_name,duration",
                "-of",
                "json",
                str(path),
            ],
            opt,
            context,
        )
    except AudioError as exc:
        if exc.code == "PROCESS_FAILED":
            raise AudioError(
                "MEDIA_INVALID", "The file is not readable media or its header is damaged."
            ) from exc
        raise
    try:
        raw = json.loads(result["stdout"])
        streams = [
            {
                "index": s["index"],
                "codec": s.get("codec_name", "unknown"),
                "sample_rate": int(s.get("sample_rate", 0)),
                "channels": int(s.get("channels", 0)),
                "channel_layout": s.get("channel_layout"),
                "declared_duration_seconds": positive_duration(s.get("duration")),
                "language": s.get("tags", {}).get("language"),
            }
            for s in raw.get("streams", [])
            if s.get("codec_type") == "audio"
        ]
    except (ValueError, TypeError, KeyError) as exc:
        raise AudioError("PROBE_INVALID", "The media inspection report was invalid.") from exc
    assert_source(path, identity)
    if not streams:
        raise AudioError("NO_AUDIO", "The file contains no readable audio stream.")
    if len(streams) > 64:
        raise AudioError("AUDIO_UNSUPPORTED", "At most 64 selectable audio tracks are supported.")
    if len(streams) > 1 and opt.stream_index is None:
        raise AudioError(
            "STREAM_REQUIRED", "Choose stream_index for a file with multiple audio streams."
        )
    selected = (
        streams[0]
        if opt.stream_index is None
        else next((s for s in streams if s["index"] == opt.stream_index), None)
    )
    if selected is None:
        raise AudioError("STREAM_INVALID", "The selected audio stream does not exist.")
    if selected["codec"] == "unknown":
        raise AudioError("CODEC_UNSUPPORTED", "The selected audio codec is unsupported.")
    if not 1 <= selected["channels"] <= 8 or not 8000 <= selected["sample_rate"] <= 192000:
        raise AudioError("AUDIO_UNSUPPORTED", "Inputs support 1-8 channels and 8-192 kHz.")
    declared = selected["declared_duration_seconds"] or positive_duration(
        raw.get("format", {}).get("duration")
    )
    if declared and declared > opt.max_duration_seconds + 0.05:
        raise AudioError("DURATION_LIMIT", "The recording exceeds the configured duration limit.")
    return {
        "schema_version": 1,
        "kind": "inspection",
        "file": {
            "name": path.name,
            "size_bytes": identity[2],
            "container": raw.get("format", {}).get("format_name", "unknown"),
        },
        "streams": streams,
        "selected_stream": selected,
        "declared_duration_seconds": declared,
    }
