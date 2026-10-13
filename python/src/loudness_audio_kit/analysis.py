"""Complete decoded measurements with bounded waveform/event storage."""

import hashlib
import math
import os
import re
import time
from typing import Any

import numpy as np
from scipy.signal import lfilter

from ._process import run
from .errors import AudioError
from .inspection import MEDIA_FORMATS, assert_source, inspect, source_file
from .options import Context, Json, Options, notify, options_for


def db(value: float) -> float | None:
    return 20 * math.log10(value) if value > 0 else None


def finite_reading(value: str) -> float | None:
    n = float(value)
    return n if math.isfinite(n) else None


class Scanner:
    def __init__(self, rate: int, channels: int, options: Options):
        self.rate, self.count, self.options = rate, channels, options
        self.frames = 0
        self.remainder = b""
        self.hash = hashlib.sha256()
        self.peak = np.zeros(channels)
        self.squares = np.zeros(channels)
        self.sums = np.zeros(channels)
        self.clips = np.zeros(channels, dtype=np.int64)
        self.run = np.zeros(channels, dtype=np.int64)
        self.longest = np.zeros(channels, dtype=np.int64)
        self.previous: Any = None
        self.cross = 0.0
        self.bands = np.zeros(3)
        self.filter_states = [np.zeros((1, channels)), np.zeros((1, channels))]
        self.waveform: list[Json] = []
        self.wave_frames = max(1, round(rate / 10))
        self.wave_start = self.wave_n = 0
        self.wave_min, self.wave_max, self.wave_power = math.inf, -math.inf, 0.0
        self.window_n = 0
        self.window_power = 0.0
        self.quiet_start: float | None = None
        self.silence_intervals: list[Json] = []
        self.silence_count = 0
        self.silence_total = self.leading = self.trailing = 0.0
        self.discontinuities: list[Json] = []
        self.discontinuity_count = 0

    def consume(self, chunk: bytes) -> None:
        data = self.remainder + chunk
        usable = len(data) - len(data) % (self.count * 8)
        self.remainder = data[usable:]
        if not usable:
            return
        audio = np.frombuffer(data[:usable], dtype="<f8").reshape(-1, self.count)
        if not np.isfinite(audio).all() or np.max(np.abs(audio)) > 1e100:
            raise AudioError(
                "PCM_INVALID", "Decoded audio contains invalid or numerically unsafe samples."
            )
        if self.frames + len(audio) > self.options.max_duration_seconds * self.rate:
            raise AudioError(
                "DURATION_LIMIT", "Decoded audio exceeds the configured duration limit."
            )
        self.hash.update(data[:usable])
        self.peak = np.maximum(self.peak, np.max(np.abs(audio), axis=0))
        self.squares += np.sum(audio * audio, axis=0)
        self.sums += np.sum(audio, axis=0)
        if self.count == 2:
            self.cross += float(np.dot(audio[:, 0], audio[:, 1]))
        for ch in range(self.count):
            clipped = np.abs(audio[:, ch]) >= self.options.clipping_threshold
            self.clips[ch] += np.count_nonzero(clipped)
            changes = np.diff(np.concatenate(([False], clipped, [False])).astype(np.int8))
            starts, ends = np.flatnonzero(changes == 1), np.flatnonzero(changes == -1)
            lengths = ends - starts
            if len(lengths):
                if starts[0] == 0:
                    lengths[0] += self.run[ch]
                self.longest[ch] = max(self.longest[ch], int(np.max(lengths)))
                self.run[ch] = lengths[-1] if ends[-1] == len(audio) else 0
            else:
                self.run[ch] = 0
        previous = (
            np.vstack((self.previous, audio[:-1])) if self.previous is not None else audio[:-1]
        )
        current = audio if self.previous is not None else audio[1:]
        jump_indices = np.argwhere(
            np.abs(current - previous) >= self.options.discontinuity_threshold
        )
        self.discontinuity_count += len(jump_indices)
        for at, ch in jump_indices[: max(0, self.options.max_events - len(self.discontinuities))]:
            self.discontinuities.append(
                {
                    "time_seconds": (
                        self.frames + int(at) + (0 if self.previous is not None else 1)
                    )
                    / self.rate,
                    "channel": int(ch),
                }
            )
        self.previous = audio[-1:].copy()
        filtered = []
        for i, frequency in enumerate((200, 2000)):
            alpha = 1 - math.exp(-2 * math.pi * frequency / self.rate)
            values, self.filter_states[i] = lfilter(
                [alpha], [1, -(1 - alpha)], audio, axis=0, zi=self.filter_states[i]
            )
            filtered.append(values)
        for i, band in enumerate((filtered[0], filtered[1] - filtered[0], audio - filtered[1])):
            self.bands[i] += np.sum(band * band)
        offset = 0
        while offset < len(audio):
            n = min(
                len(audio) - offset,
                self.wave_frames - self.wave_n,
                max(1, round(self.rate / 10)) - self.window_n,
            )
            part = audio[offset : offset + n]
            power = float(np.sum(part * part) / self.count)
            self.wave_min = min(self.wave_min, float(np.min(part)))
            self.wave_max = max(self.wave_max, float(np.max(part)))
            self.wave_power += power
            self.window_power += power
            self.frames += n
            self.wave_n += n
            self.window_n += n
            offset += n
            if self.wave_n >= self.wave_frames:
                self.flush_wave()
            if self.window_n >= round(self.rate / 10):
                self.flush_quiet()

    def flush_wave(self) -> None:
        if not self.wave_n:
            return
        self.waveform.append(
            {
                "start_seconds": self.wave_start / self.rate,
                "end_seconds": self.frames / self.rate,
                "min": self.wave_min,
                "max": self.wave_max,
                "rms": math.sqrt(self.wave_power / self.wave_n),
            }
        )
        self.wave_start = self.frames
        self.wave_n = 0
        self.wave_power = 0.0
        self.wave_min, self.wave_max = math.inf, -math.inf
        if len(self.waveform) > self.options.max_points:
            merged = []
            for i in range(0, len(self.waveform), 2):
                a = self.waveform[i]
                if i + 1 == len(self.waveform):
                    merged.append(a)
                    continue
                b = self.waveform[i + 1]
                da, db_ = (
                    a["end_seconds"] - a["start_seconds"],
                    b["end_seconds"] - b["start_seconds"],
                )
                merged.append(
                    {
                        "start_seconds": a["start_seconds"],
                        "end_seconds": b["end_seconds"],
                        "min": min(a["min"], b["min"]),
                        "max": max(a["max"], b["max"]),
                        "rms": math.sqrt((a["rms"] ** 2 * da + b["rms"] ** 2 * db_) / (da + db_)),
                    }
                )
            self.waveform = merged
            self.wave_frames *= 2

    def flush_quiet(self) -> None:
        if not self.window_n:
            return
        start = (self.frames - self.window_n) / self.rate
        if self.window_power / self.window_n <= 10 ** (self.options.silence_threshold_dbfs / 10):
            if self.quiet_start is None:
                self.quiet_start = start
        else:
            self.end_quiet(start)
        self.window_n = 0
        self.window_power = 0.0

    def end_quiet(self, end: float) -> None:
        if self.quiet_start is not None:
            duration = end - self.quiet_start
            if duration + 1e-9 >= self.options.min_silence_seconds:
                self.silence_total += duration
                self.silence_count += 1
                if self.quiet_start == 0:
                    self.leading = duration
                if abs(end - self.frames / self.rate) < 1e-9:
                    self.trailing = duration
                if len(self.silence_intervals) < self.options.max_events:
                    self.silence_intervals.append(
                        {"start_seconds": self.quiet_start, "end_seconds": end}
                    )
        self.quiet_start = None

    def finish(self) -> Json:
        if self.remainder or not self.frames:
            raise AudioError(
                "PCM_INVALID", "Decoded PCM is empty or ends with an incomplete sample."
            )
        self.flush_wave()
        self.flush_quiet()
        self.end_quiet(self.frames / self.rate)
        channels = []
        for ch in range(self.count):
            peak = db(float(self.peak[ch]))
            rms = db(math.sqrt(float(self.squares[ch]) / self.frames))
            channels.append(
                {
                    "sample_peak_dbfs": peak,
                    "rms_dbfs": rms,
                    "crest_factor_db": peak - rms if peak is not None and rms is not None else None,
                    "dc_offset": float(self.sums[ch]) / self.frames,
                    "near_full_scale_samples": int(self.clips[ch]),
                    "longest_near_full_scale_run": int(self.longest[ch]),
                }
            )
        correlation = None
        imbalance = None
        if self.count == 2:
            v = self.squares - self.sums**2 / self.frames
            if min(v) > 1e-20:
                correlation = max(
                    -1.0,
                    min(
                        1.0,
                        (self.cross - self.sums[0] * self.sums[1] / self.frames)
                        / math.sqrt(v[0] * v[1]),
                    ),
                )
            rms_left, rms_right = channels[0]["rms_dbfs"], channels[1]["rms_dbfs"]
            if rms_left is not None and rms_right is not None:
                imbalance = rms_left - rms_right
        return {
            "channels": channels,
            "sample_peak_dbfs": db(float(max(self.peak))),
            "rms_dbfs": db(math.sqrt(float(sum(self.squares)) / self.frames / self.count)),
            "pcm_hash": self.hash.hexdigest(),
            "correlation": correlation,
            "imbalance": imbalance,
            "bands": [db(math.sqrt(float(v) / self.frames / self.count)) for v in self.bands],
        }


def analyze(
    file: str | os.PathLike[str],
    options: Options | None = None,
    *,
    _context: Context | None = None,
    **kwargs: Any,
) -> Json:
    opt = options_for(options, **kwargs)
    context = _context or Context(opt)
    source, identity = source_file(file, opt, context)
    info = inspect(source, opt, _context=context)
    stream = info["selected_stream"]
    rate = stream["sample_rate"]
    scanner = Scanner(rate, stream["channels"], opt)
    timeline: list[Json] = []
    stride, lines = 1, 0
    eligible = corrupt = False
    last_progress = 0.0

    def consume(chunk: bytes) -> None:
        nonlocal last_progress
        scanner.consume(chunk)
        now = time.monotonic()
        if now - last_progress > 0.2:
            seconds = scanner.frames / rate
            declared = info["declared_duration_seconds"]
            notify(
                opt,
                "decode",
                min(0.99, seconds / declared) if declared else None,
                decoded_seconds=seconds,
            )
            last_progress = now

    def line(text: str) -> None:
        nonlocal eligible, corrupt, stride, timeline, lines
        if re.search(r"Packet corrupt|corrupt input packet|Invalid data found", text, re.I):
            corrupt = True
        match = re.search(r"\bt:\s*([\d.]+).*?\bM:\s*(-?[\d.]+).*?\bS:\s*(-?[\d.]+)", text)
        if not match:
            return
        t, m, s = map(float, match.groups())
        t += 1 / rate
        if t >= 0.4 - 1e-5 and m >= -70:
            eligible = True
        if lines % stride == 0:
            timeline.append(
                {
                    "time_seconds": t,
                    "momentary_lufs": m if t >= 0.4 - 1e-5 and m > -120 else None,
                    "short_term_lufs": s if t >= 3 - 1e-5 and s > -120 else None,
                }
            )
        lines += 1
        if len(timeline) > opt.max_points:
            timeline = timeline[::2]
            stride *= 2

    try:
        result = run(
            opt.ffmpeg_path,
            [
                "-hide_banner",
                "-nostdin",
                "-nostats",
                "-v",
                "verbose",
                "-xerror",
                "-threads",
                str(opt.native_threads),
                "-filter_threads",
                "1",
                "-protocol_whitelist",
                "file,pipe",
                "-format_whitelist",
                MEDIA_FORMATS,
                "-i",
                str(source),
                "-map",
                f"0:{stream['index']}",
                "-vn",
                "-sn",
                "-dn",
                "-af",
                f"aformat=sample_fmts=dbl:sample_rates={rate},ebur128=peak=true:framelog=verbose,aformat=sample_fmts=dbl:sample_rates={rate}",
                "-c:a",
                "pcm_f64le",
                "-f",
                "f64le",
                "pipe:1",
            ],
            opt,
            context,
            on_chunk=consume,
            on_stderr_line=line,
        )
    except AudioError as exc:
        if exc.code == "PROCESS_FAILED":
            raise AudioError("DECODE_FAILED", "The audio could not be decoded completely.") from exc
        raise
    assert_source(source, identity)
    if corrupt:
        raise AudioError("DECODE_INVALID", "The decoder reported corrupt or truncated media.")
    stats = scanner.finish()
    summary = result["stderr"][result["stderr"].rfind("Summary:") :]
    integrated = re.search(r"\bI:\s*(-?[\d.]+|[-+]?inf)\s+LUFS", summary)
    lra = re.search(r"\bLRA:\s*(-?[\d.]+)\s+LU", summary)
    peak = re.search(r"True peak:\s*Peak:\s*(-?[\d.]+|[-+]?inf)\s+dBFS", summary)
    if not all((integrated, lra, peak)):
        raise AudioError("MEASUREMENT_INVALID", "The loudness summary was incomplete.")
    assert integrated and lra and peak
    duration = scanner.frames / rate
    state = (
        "silent"
        if stats["sample_peak_dbfs"] is None
        else "too_short"
        if duration < 0.4
        else "below_loudness_gate"
        if not eligible
        else "unknown_channel_layout"
        if stream["channels"] > 2 and not stream["channel_layout"]
        else "measured"
    )
    if state == "unknown_channel_layout":
        timeline = [{**p, "momentary_lufs": None, "short_term_lufs": None} for p in timeline]
    report = {
        "schema_version": 1,
        "kind": "analysis",
        "input": info,
        "duration_seconds": duration,
        "frames": scanner.frames,
        "decoded_pcm_sha256": stats["pcm_hash"],
        "state": state,
        "integrated_lufs": finite_reading(integrated[1]) if state == "measured" else None,
        "true_peak_dbtp": finite_reading(peak[1]) if state != "silent" else None,
        "loudness_range_lu": float(lra[1]) if state == "measured" and duration >= 10 else None,
        "sample_peak_dbfs": stats["sample_peak_dbfs"],
        "rms_dbfs": stats["rms_dbfs"],
        "channels": stats["channels"],
        "stereo_correlation": stats["correlation"],
        "channel_imbalance_db": stats["imbalance"],
        "silence": {
            "threshold_dbfs": opt.silence_threshold_dbfs,
            "min_seconds": opt.min_silence_seconds,
            "total_seconds": scanner.silence_total,
            "leading_seconds": scanner.leading,
            "trailing_seconds": scanner.trailing,
            "intervals": scanner.silence_intervals,
            "total_intervals": scanner.silence_count,
        },
        "discontinuities": {
            "threshold": opt.discontinuity_threshold,
            "total_candidates": scanner.discontinuity_count,
            "candidates": scanner.discontinuities,
        },
        "band_energy": {
            "method": "one-pole-crossover",
            **dict(zip(("low_dbfs", "mid_dbfs", "high_dbfs"), stats["bands"], strict=True)),
        },
        "waveform": scanner.waveform,
        "loudness_timeline": timeline,
        "coverage": {
            "waveform_bin_seconds": max(
                p["end_seconds"] - p["start_seconds"] for p in scanner.waveform
            ),
            "loudness_stride": stride,
            "events_capped": scanner.silence_count > len(scanner.silence_intervals)
            or scanner.discontinuity_count > len(scanner.discontinuities),
        },
        "settings": {
            "clipping_threshold": opt.clipping_threshold,
            "native_threads": opt.native_threads,
        },
    }
    notify(opt, "complete", 1, decoded_seconds=duration)
    return report
