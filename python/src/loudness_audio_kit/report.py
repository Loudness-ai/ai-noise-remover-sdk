"""Portable offline HTML reports with escaped data and no remote dependencies."""

import html
import json
import math

from ._brand import brand_svg
from .errors import AudioError
from .options import Json

KINDS = {
    "inspection",
    "analysis",
    "validation",
    "comparison",
    "batch",
    "processing",
    "processing-batch",
    "benchmark",
}


def _number(value: object, *, nullable: bool = False) -> bool:
    return value is None and nullable or type(value) in (int, float) and math.isfinite(value)  # type: ignore[arg-type]


def _shape(value: Json, depth: int = 0) -> None:
    if (
        depth > 12
        or not isinstance(value, dict)
        or type(value.get("schema_version")) is not int
        or value.get("schema_version") != 1
        or not isinstance(value.get("kind"), str)
        or value["kind"] not in KINDS
    ):
        raise ValueError()
    kind = value["kind"]
    if kind == "inspection":
        file, stream = value["file"], value["selected_stream"]
        if (
            not isinstance(file, dict)
            or not isinstance(stream, dict)
            or not isinstance(file["name"], str)
            or not isinstance(file["container"], str)
            or type(file["size_bytes"]) is not int
            or file["size_bytes"] < 1
            or type(stream["channels"]) is not int
            or not 1 <= stream["channels"] <= 8
            or type(stream["sample_rate"]) is not int
            or not 8000 <= stream["sample_rate"] <= 192000
            or not isinstance(stream["codec"], str)
            or not isinstance(value["streams"], list)
        ):
            raise ValueError()
    elif kind == "analysis":
        _shape(value["input"], depth + 1)
        if value["input"]["kind"] != "inspection":
            raise ValueError()
        if (
            not _number(value["duration_seconds"])
            or value["duration_seconds"] <= 0
            or type(value["frames"]) is not int
            or value["frames"] < 1
            or not isinstance(value["channels"], list)
            or len(value["channels"]) != value["input"]["selected_stream"]["channels"]
            or not isinstance(value["waveform"], list)
            or len(value["waveform"]) > 16384
        ):
            raise ValueError()
        for name in (
            "integrated_lufs",
            "true_peak_dbtp",
            "rms_dbfs",
            "sample_peak_dbfs",
            "channel_imbalance_db",
        ):
            if not _number(value[name], nullable=True):
                raise ValueError()
        for channel in value["channels"]:
            if (
                not isinstance(channel, dict)
                or not _number(channel["dc_offset"])
                or any(
                    type(channel[k]) is not int or channel[k] < 0
                    for k in ("near_full_scale_samples", "longest_near_full_scale_run")
                )
            ):
                raise ValueError()
        for key in ("total_seconds", "leading_seconds", "trailing_seconds"):
            if not _number(value["silence"][key]) or value["silence"][key] < 0:
                raise ValueError()
        for point in value["waveform"]:
            if (
                not isinstance(point, dict)
                or not all(
                    _number(point[k]) for k in ("start_seconds", "end_seconds", "min", "max")
                )
                or not 0
                <= point["start_seconds"]
                <= point["end_seconds"]
                <= value["duration_seconds"] + 0.00001
                or point["min"] > point["max"]
            ):
                raise ValueError()
    elif kind in ("processing", "validation"):
        _shape(value["analysis"], depth + 1)
        if value["analysis"]["kind"] != "analysis":
            raise ValueError()
        if kind == "processing":
            if value["mode"] not in (
                "denoise",
                "enhance",
                "normalize",
                "convert",
            ) or not isinstance(value["output"], dict):
                raise ValueError()
        elif type(value["failed"]) is not bool or not isinstance(value["results"], list):
            raise ValueError()
    elif kind == "comparison":
        for key in ("before", "after"):
            _shape(value[key], depth + 1)
            if value[key]["kind"] != "analysis":
                raise ValueError()
    else:
        entries = value["runs" if kind == "benchmark" else "results"]
        if not isinstance(entries, list) or len(entries) > 100000:
            raise ValueError()
        for entry in entries:
            if not isinstance(entry, dict) or entry["state"] not in (
                "completed",
                "failed",
                "cancelled",
            ):
                raise ValueError()
            if entry["state"] == "completed":
                report_key = "result" if kind == "processing-batch" else "analysis"
                _shape(entry[report_key], depth + 1)


def check_report(value: Json) -> None:
    try:
        encoded = json.dumps(value, allow_nan=False)
    except (ValueError, TypeError, RecursionError) as exc:
        raise AudioError("REPORT_INVALID", "Reports must contain finite JSON data.") from exc
    if len(encoded) > 32 * 1024 * 1024:
        raise AudioError("REPORT_INVALID", "The report exceeds the supported size.")
    try:
        _shape(value)
    except (KeyError, IndexError, TypeError, AttributeError, ValueError, RecursionError) as exc:
        raise AudioError(
            "REPORT_INVALID", "Invalid report version, kind or measurement structure."
        ) from exc


def render_report(value: Json, *, title: str = "Loudness.ai Audio Report") -> str:
    check_report(value)
    title_html = html.escape(str(title))
    analysis = value if value["kind"] == "analysis" else value.get("analysis", value.get("after"))
    cards, waveform = "", ""
    if analysis and analysis.get("kind") == "analysis":
        for key, label, unit in [
            ("duration_seconds", "Duration", "s"),
            ("integrated_lufs", "Integrated loudness", "LUFS"),
            ("true_peak_dbtp", "True peak", "dBTP"),
            ("rms_dbfs", "RMS", "dBFS"),
        ]:
            n = analysis.get(key)
            display = (
                f"{n:.2f} {unit}"
                if isinstance(n, (float, int)) and math.isfinite(n)
                else "Unavailable"
            )
            cards += f"<div class=metric><span>{label}</span><strong>{display}</strong></div>"
        duration = analysis.get("duration_seconds")
        if isinstance(duration, (int, float)) and duration > 0:
            for p in analysis.get("waveform", []):
                if not all(
                    type(p.get(k)) in (int, float)
                    for k in ("start_seconds", "end_seconds", "min", "max")
                ):
                    raise AudioError("REPORT_INVALID", "Invalid waveform point.")
                x = p["start_seconds"] / duration * 1000
                width = max(0.2, (p["end_seconds"] - p["start_seconds"]) / duration * 1000)
                low, high = max(-1, min(1, p["min"])), max(-1, min(1, p["max"]))
                waveform += f'<rect x="{x:.3f}" y="{60 - high * 55:.3f}" width="{width:.3f}" height="{max(0.5, (high - low) * 55):.3f}"/>'
    payload = html.escape(json.dumps(value, indent=2, allow_nan=False))
    return f"""<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>{title_html}</title><style>body{{font-family:system-ui,sans-serif;margin:0;background:#fff;color:#000}}main{{max-width:1100px;margin:auto;padding:32px 20px}}h1{{font-size:32px}}.brand{{font-weight:800;font-size:25px}}.brand span{{color:#ff4b1f}}.metrics{{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:24px 0}}.metric{{padding:18px;background:#f3f3f3;border-radius:12px}}.metric span,.metric strong{{display:block}}.metric strong{{font-size:22px;margin-top:8px}}svg{{width:100%;fill:#ff4b1f;background:#f7f7f7;border-radius:12px}}.brand svg{{width:226px;height:32px;background:transparent;border-radius:0}}pre{{overflow:auto;background:#000;color:#fff;padding:20px;border-radius:12px;font-size:12px}}summary{{cursor:pointer;padding:16px 0}}</style>
<main><div class="brand" style="width:226px">{brand_svg()}</div><h1>{title_html}</h1><p>Measured audio results. Loudness and signal statistics do not establish listening quality.</p>
<section class="metrics">{cards}</section>{f'<svg viewBox="0 0 1000 120" role="img" aria-label="Audio waveform">{waveform}</svg>' if waveform else ""}
<details open><summary>Complete measurements</summary><pre>{payload}</pre></details></main></html>"""
