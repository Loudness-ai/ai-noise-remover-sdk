"""Measured differences and bounded alignment evidence, not listening-quality scores."""

import math
import os
from dataclasses import replace
from typing import Any

import numpy as np

from ._process import run
from .analysis import analyze, db
from .errors import AudioError
from .inspection import MEDIA_FORMATS, assert_source, source_file
from .options import Context, Json, Options, bounded, notify, options_for


def difference(a: Any, b: Any) -> float | None:
    return b - a if a is not None and b is not None else None


def _window(
    file: str | os.PathLike[str],
    at: float,
    width: float,
    stream: int,
    opt: Options,
    context: Context,
) -> Any:
    path, _ = source_file(file, opt, context)
    result = run(
        opt.ffmpeg_path,
        [
            "-v",
            "error",
            "-nostdin",
            "-xerror",
            "-threads",
            str(opt.native_threads),
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            MEDIA_FORMATS,
            "-ss",
            str(at),
            "-i",
            str(path),
            "-t",
            str(width),
            "-map",
            f"0:{stream}",
            "-vn",
            "-sn",
            "-dn",
            "-ac",
            "1",
            "-ar",
            "400",
            "-c:a",
            "pcm_f64le",
            "-f",
            "f64le",
            "pipe:1",
        ],
        opt,
        context,
        max_stdout_bytes=200000,
    )
    if len(result["stdout"]) % 8:
        raise AudioError("PCM_INVALID", "The alignment window was incomplete.")
    return np.frombuffer(result["stdout"], dtype="<f8")


def _align(a: Any, b: Any, max_lag: int, at: float) -> Json:
    scored = []
    for lag in range(-max_lag, max_lag + 1):
        start, end = max(100, 100 - lag), min(len(a) - 100, len(b) - lag - 100)
        if end - start < 200:
            continue
        x, y = a[start:end], b[start + lag : end + lag]
        x, y = x - np.mean(x), y - np.mean(y)
        aa, bb, ab = float(np.dot(x, x)), float(np.dot(y, y)), float(np.dot(x, y))
        if min(aa, bb) < 1e-15:
            continue
        scored.append(
            {
                "lag": lag,
                "score": ab / math.sqrt(aa * bb),
                "gain": ab / aa,
                "residual": math.sqrt(max(0, (bb - ab * ab / aa) / len(x))),
            }
        )
    scored.sort(key=lambda v: v["score"], reverse=True)
    best = scored[0] if scored else None
    second = next((s for s in scored if best and abs(s["lag"] - best["lag"]) > 8), None)
    confidence = (
        "unavailable"
        if not best
        else "high"
        if best["score"] >= 0.8 and (not second or best["score"] - second["score"] > 0.03)
        else "ambiguous"
    )
    return {
        "at_seconds": at,
        "offset_seconds": best["lag"] / 400 if best and confidence == "high" else None,
        "correlation": best["score"] if best else None,
        "confidence": confidence,
        "gain_db": db(abs(best["gain"])) if best and confidence == "high" else None,
        "residual_rms": best["residual"] if best and confidence == "high" else None,
    }


def compare(
    before_file: str | os.PathLike[str],
    after_file: str | os.PathLike[str],
    options: Options | None = None,
    *,
    tolerance_seconds: float = 0.05,
    max_alignment_seconds: float = 0.5,
    allow: dict[str, bool] | None = None,
    **kwargs: Any,
) -> Json:
    bounded(tolerance_seconds, "tolerance_seconds", 0, 604800)
    bounded(max_alignment_seconds, "max_alignment_seconds", 0, 2)
    if allow is not None and (
        not isinstance(allow, dict)
        or set(allow) - {"trim", "resample", "channels", "gain"}
        or any(type(v) is not bool for v in allow.values())
    ):
        raise AudioError("CONFIG_INVALID", "Invalid allowed comparison changes.")
    allow = allow or {}
    opt = options_for(options, **kwargs)
    context = Context(opt)
    quiet = replace(opt, on_progress=None)
    before_path, before_identity = source_file(before_file, opt, context)
    after_path, after_identity = source_file(after_file, opt, context)
    before = analyze(before_file, quiet, _context=context)
    after = analyze(after_file, quiet, _context=context)
    notify(opt, "compare", 0)
    duration = min(before["duration_seconds"], after["duration_seconds"])
    width = min(4.0, duration)
    times = sorted({0.0, max(0.0, (duration - width) / 2), max(0.0, duration - width)})
    alignment = []
    for at in times:
        context.check()
        a = _window(
            before_file, at, width, before["input"]["selected_stream"]["index"], quiet, context
        )
        b = _window(
            after_file, at, width, after["input"]["selected_stream"]["index"], quiet, context
        )
        alignment.append(_align(a, b, round(max_alignment_seconds * 400), at))
    reliable = [w for w in alignment if w["confidence"] == "high"]
    drift = (
        reliable[-1]["offset_seconds"] - reliable[0]["offset_seconds"]
        if len(reliable) > 1
        else None
    )
    duration_delta = after["duration_seconds"] - before["duration_seconds"]
    channel_change = len(before["channels"]) != len(after["channels"])
    sample_rate_change = (
        before["input"]["selected_stream"]["sample_rate"]
        != after["input"]["selected_stream"]["sample_rate"]
    )
    findings = []
    for code, changed, permitted, message in [
        (
            "DURATION_CHANGED",
            abs(duration_delta) > tolerance_seconds,
            allow.get("trim", False),
            "Decoded duration changed.",
        ),
        (
            "CHANNELS_CHANGED",
            channel_change,
            allow.get("channels", False),
            "Channel count changed.",
        ),
        (
            "SAMPLE_RATE_CHANGED",
            sample_rate_change,
            allow.get("resample", False),
            "Sample rate changed.",
        ),
        (
            "GAIN_CHANGED",
            any(w["gain_db"] is not None and abs(w["gain_db"]) > 0.5 for w in reliable),
            allow.get("gain", False),
            "Aligned signal gain changed.",
        ),
    ]:
        if changed:
            findings.append(
                {"code": code, "severity": "info" if permitted else "warning", "message": message}
            )
    result = {
        "schema_version": 1,
        "kind": "comparison",
        "before": before,
        "after": after,
        "decoded_pcm_equal": before["decoded_pcm_sha256"] == after["decoded_pcm_sha256"]
        and not sample_rate_change
        and not channel_change,
        "duration_delta_seconds": duration_delta,
        "duration_within_tolerance": abs(duration_delta) <= tolerance_seconds,
        "loudness_delta_lu": difference(before["integrated_lufs"], after["integrated_lufs"]),
        "peak_delta_db": difference(before["true_peak_dbtp"], after["true_peak_dbtp"]),
        "differences": {
            "frames": after["frames"] - before["frames"],
            "rms_db": difference(before["rms_dbfs"], after["rms_dbfs"]),
            **{
                name: after["silence"][key] - before["silence"][key]
                for name, key in [
                    ("quiet_seconds", "total_seconds"),
                    ("leading_quiet_seconds", "leading_seconds"),
                    ("trailing_quiet_seconds", "trailing_seconds"),
                ]
            },
            "channel_imbalance_db": difference(
                before["channel_imbalance_db"], after["channel_imbalance_db"]
            ),
            "bands_db": {
                band: difference(
                    before["band_energy"][band + "_dbfs"], after["band_energy"][band + "_dbfs"]
                )
                for band in ("low", "mid", "high")
            },
            "channels": [
                {
                    "channel": i,
                    "rms_db": difference(a["rms_dbfs"], b["rms_dbfs"]),
                    "sample_peak_db": difference(a["sample_peak_dbfs"], b["sample_peak_dbfs"]),
                    "dc_offset": b["dc_offset"] - a["dc_offset"],
                }
                for i, (a, b) in enumerate(zip(before["channels"], after["channels"], strict=False))
            ],
        },
        "channel_change": channel_change,
        "sample_rate_change": sample_rate_change,
        "alignment": alignment,
        "drift_seconds": drift,
        "findings": findings,
        "limitations": [
            "Measurements are not perceptual quality scores.",
            "Alignment uses bounded 400 Hz mono windows; periodic/silent signals may be ambiguous.",
        ],
    }
    assert_source(before_path, before_identity)
    assert_source(after_path, after_identity)
    context.check()
    notify(opt, "complete", 1)
    return result
