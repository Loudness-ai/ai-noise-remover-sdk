"""Explicit measurement policies; unavailable never silently passes a rule."""

import copy
import math
import os
from typing import Any

from .analysis import analyze
from .errors import AudioError
from .options import Json, Options
from .report import check_report

UNITS = {
    "duration_seconds": "s",
    "size_bytes": "bytes",
    "channels": "channels",
    "sample_rate": "Hz",
    "integrated_lufs": "LUFS",
    "true_peak_dbtp": "dBTP",
    "sample_peak_dbfs": "dBFS",
    "rms_dbfs": "dBFS",
    "near_full_scale_samples": "samples",
    "longest_near_full_scale_run": "samples",
    "max_abs_dc_offset": "FS",
    "silence_seconds": "s",
    "leading_silence_seconds": "s",
    "trailing_silence_seconds": "s",
    "channel_imbalance_db": "dB",
}
EXAMPLE_POLICY: Json = {
    "schema_version": 1,
    "name": "Speech delivery",
    "unavailable": "warning",
    "rules": [
        {"metric": "integrated_lufs", "min": -20, "max": -14},
        {"metric": "true_peak_dbtp", "max": -1},
        {"metric": "near_full_scale_samples", "max": 0},
        {"metric": "max_abs_dc_offset", "max": 0.01, "severity": "warning"},
    ],
}


def check_policy(policy: Json) -> None:
    if (
        not isinstance(policy, dict)
        or set(policy) - {"schema_version", "name", "rules", "codecs", "containers", "unavailable"}
        or type(policy.get("schema_version")) is not int
        or policy["schema_version"] != 1
        or not isinstance(policy.get("name"), str)
        or not policy["name"]
        or not isinstance(policy.get("rules"), list)
        or len(policy["rules"]) > 1000
        or policy.get("unavailable", "warning") not in ("warning", "fail")
    ):
        raise AudioError("POLICY_INVALID", "Invalid policy header or unknown option.")
    for rule in policy["rules"]:
        if (
            not isinstance(rule, dict)
            or set(rule) - {"metric", "min", "max", "severity"}
            or not isinstance(rule.get("metric"), str)
            or rule.get("metric") not in UNITS
            or not ({"min", "max"} & rule.keys())
            or rule.get("severity", "fail") not in ("fail", "warning")
        ):
            raise AudioError("POLICY_INVALID", "Invalid policy metric or rule.")
        for key in ("min", "max"):
            if key in rule and (
                type(rule[key]) not in (int, float) or not math.isfinite(rule[key])
            ):
                raise AudioError("POLICY_INVALID", "Policy bounds must be finite numbers.")
        if "min" in rule and "max" in rule and rule["min"] > rule["max"]:
            raise AudioError("POLICY_INVALID", "Policy minimum exceeds maximum.")
    for key in ("codecs", "containers"):
        if key in policy and (
            not isinstance(policy[key], list)
            or not policy[key]
            or not all(isinstance(v, str) and v for v in policy[key])
        ):
            raise AudioError("POLICY_INVALID", "Format constraints must be nonempty string lists.")


def measurement(analysis: Json, key: str) -> Any:
    if key == "size_bytes":
        return analysis["input"]["file"][key]
    if key == "channels":
        return len(analysis["channels"])
    if key == "sample_rate":
        return analysis["input"]["selected_stream"][key]
    if key == "near_full_scale_samples":
        return sum(c[key] for c in analysis["channels"])
    if key == "longest_near_full_scale_run":
        return max(c[key] for c in analysis["channels"])
    if key == "max_abs_dc_offset":
        return max(abs(c["dc_offset"]) for c in analysis["channels"])
    if key in ("silence_seconds", "leading_silence_seconds", "trailing_silence_seconds"):
        return analysis["silence"][
            {
                "silence_seconds": "total_seconds",
                "leading_silence_seconds": "leading_seconds",
                "trailing_silence_seconds": "trailing_seconds",
            }[key]
        ]
    if key == "channel_imbalance_db":
        value = analysis[key]
        return abs(value) if value is not None else None
    return analysis[key]


def evaluate(analysis: Json, policy: Json) -> Json:
    check_policy(policy)
    check_report(analysis)
    if analysis.get("kind") != "analysis":
        raise AudioError("REPORT_INVALID", "Provide an audio analysis report.")
    results = []
    for rule in policy["rules"]:
        value = measurement(analysis, rule["metric"])
        outside = value is not None and (
            ("min" in rule and value < rule["min"]) or ("max" in rule and value > rule["max"])
        )
        state = (
            "unavailable" if value is None else rule.get("severity", "fail") if outside else "pass"
        )
        results.append(
            {
                "metric": rule["metric"],
                "unit": UNITS[rule["metric"]],
                "status": state,
                "value": value,
                **{k: rule[k] for k in ("min", "max") if k in rule},
                "message": "Measurement unavailable."
                if value is None
                else "Outside configured bounds."
                if outside
                else "Meets configured bounds.",
            }
        )
    for key, name, value in [
        ("codecs", "codec", analysis["input"]["selected_stream"]["codec"]),
        ("containers", "container", analysis["input"]["file"]["container"]),
    ]:
        if key in policy:
            permitted = any(v in policy[key] for v in value.split(","))
            results.append(
                {
                    "metric": name,
                    "unit": "",
                    "status": "pass" if permitted else "fail",
                    "value": value,
                    "message": "Format permitted." if permitted else "Format is not permitted.",
                }
            )
    failed = any(
        r["status"] == "fail"
        or r["status"] == "unavailable"
        and policy.get("unavailable") == "fail"
        for r in results
    )
    return {
        "schema_version": 1,
        "kind": "validation",
        "policy": copy.deepcopy(policy),
        "failed": failed,
        "passed": not failed and all(r["status"] == "pass" for r in results),
        "results": results,
        "analysis": analysis,
    }


def validate(
    file: str | os.PathLike[str], policy: Json, options: Options | None = None, **kwargs: Any
) -> Json:
    check_policy(policy)
    return evaluate(analyze(file, options, **kwargs), policy)
