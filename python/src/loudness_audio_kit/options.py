"""Python option names; report dictionaries also use snake_case."""

import math
import os
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, fields, replace
from typing import Any

from .errors import AudioError, CancellationToken

Json = dict[str, Any]
ProgressCallback = Callable[[Json], None]


def bounded(value: Any, name: str, low: float, high: float, integer: bool = False) -> None:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or not low <= value <= high
        or (integer and int(value) != value)
    ):
        raise AudioError(
            "CONFIG_INVALID",
            f"{name} must be {'an integer ' if integer else ''}from {low} to {high}.",
        )


@dataclass(frozen=True)
class Options:
    timeout_seconds: float = 3600
    max_file_bytes: int = 10_737_418_240
    max_duration_seconds: float = 86400
    max_temp_bytes: int = 4_294_967_296
    memory_budget_mib: int = 512
    native_threads: int = 1
    ffmpeg_path: str = "ffmpeg"
    ffprobe_path: str = "ffprobe"
    stream_index: int | None = None
    format: str | None = None
    bit_depth: int = 16
    bitrate_kbps: int = 192
    sample_rate: int | None = None
    channels: int | None = None
    strength: float = 1
    target_lufs: float = -16
    true_peak_dbtp: float = -1.5
    loudness_range_lu: float = 11
    normalize: bool | None = None
    voice_processing: bool = True
    overwrite: bool = False
    model_dir: str | os.PathLike[str] | None = None
    temp_directory: str | os.PathLike[str] | None = None
    max_points: int = 2048
    max_events: int = 128
    silence_threshold_dbfs: float = -60
    min_silence_seconds: float = 0.2
    clipping_threshold: float = 0.999
    discontinuity_threshold: float = 0.8
    cancel_token: CancellationToken | None = None
    on_progress: ProgressCallback | None = None

    def __post_init__(self) -> None:
        for name, low, high, integer in [
            ("timeout_seconds", 0.001, 2_147_483, False),
            ("max_file_bytes", 1, 2**53 - 1, True),
            ("max_duration_seconds", 0.000001, 604800, False),
            ("max_temp_bytes", 1024, 2**53 - 1, True),
            ("memory_budget_mib", 32, 65536, True),
            ("native_threads", 1, 256, True),
            ("strength", 0, 1, False),
            ("target_lufs", -70, -5, False),
            ("true_peak_dbtp", -9, 0, False),
            ("loudness_range_lu", 1, 50, False),
            ("bitrate_kbps", 16, 320, True),
            ("max_points", 16, 16384, True),
            ("max_events", 0, 10000, True),
            ("silence_threshold_dbfs", -180, 0, False),
            ("min_silence_seconds", 0.000001, 86400, False),
            ("clipping_threshold", 0.000001, 2, False),
            ("discontinuity_threshold", 0.000001, 4, False),
        ]:
            bounded(getattr(self, name), name, low, high, integer)
        for name, low, high in [
            ("sample_rate", 8000, 192000),
            ("channels", 1, 8),
            ("stream_index", 0, 100000),
        ]:
            if getattr(self, name) is not None:
                bounded(getattr(self, name), name, low, high, True)
        if isinstance(self.bit_depth, bool) or self.bit_depth not in (16, 24):
            raise AudioError("CONFIG_INVALID", "bit_depth must be 16 or 24.")
        if self.format is not None and self.format not in ("wav", "flac", "mp3", "opus"):
            raise AudioError("CONFIG_INVALID", "format must be wav, flac, mp3 or opus.")
        for name in ("overwrite", "voice_processing", "normalize"):
            if not isinstance(getattr(self, name), bool) and not (
                name == "normalize" and self.normalize is None
            ):
                raise AudioError("CONFIG_INVALID", f"{name} must be boolean.")
        for name in ("ffmpeg_path", "ffprobe_path", "model_dir", "temp_directory"):
            value = getattr(self, name)
            if value is not None:
                try:
                    value = os.fspath(value)
                except TypeError as exc:
                    raise AudioError("CONFIG_INVALID", f"{name} must be a local path.") from exc
                if not isinstance(value, str) or not value or "\0" in value:
                    raise AudioError("CONFIG_INVALID", f"{name} must be a nonempty path.")
        if self.cancel_token is not None and not isinstance(self.cancel_token, CancellationToken):
            raise AudioError("CONFIG_INVALID", "cancel_token must be a CancellationToken.")
        if self.on_progress is not None and not callable(self.on_progress):
            raise AudioError("CONFIG_INVALID", "on_progress must be callable.")


def options_for(options: Options | Mapping[str, Any] | None = None, **kwargs: Any) -> Options:
    try:
        if options is None:
            return Options(**kwargs)
        if isinstance(options, Options):
            return replace(options, **kwargs)
        if isinstance(options, Mapping):
            return Options(**{**options, **kwargs})
    except TypeError as exc:
        raise AudioError(
            "CONFIG_INVALID", "Unknown or invalid option; use documented snake_case names."
        ) from exc
    raise AudioError("CONFIG_INVALID", "options must be Options or a mapping.")


class Context:
    """One absolute deadline, shared by nested phases and queue wait."""

    def __init__(
        self,
        options: Options,
        *,
        deadline: float | None = None,
        parents: tuple[CancellationToken, ...] = (),
    ):
        self.deadline = (
            deadline if deadline is not None else time.monotonic() + options.timeout_seconds
        )
        self.token = CancellationToken(
            (*parents, *((options.cancel_token,) if options.cancel_token else ()))
        )

    def check(self) -> None:
        if self.token.cancelled:
            raise AudioError("CANCELLED", "Audio processing was cancelled.")
        if time.monotonic() >= self.deadline:
            raise AudioError("TIMEOUT", "The operation exceeded its timeout.")


def notify(options: Options, phase: str, fraction: float | None = None, **extra: Any) -> None:
    if options.on_progress:
        try:
            options.on_progress({"phase": phase, "fraction": fraction, **extra})
        except Exception as exc:
            raise AudioError("OBSERVER_ERROR", "The progress callback failed.") from exc


def worker_options(options: Options) -> Json:
    return {
        f.name: os.fspath(v) if isinstance(v, os.PathLike) else v
        for f in fields(options)
        if f.name not in ("cancel_token", "on_progress")
        for v in [getattr(options, f.name)]
    }
