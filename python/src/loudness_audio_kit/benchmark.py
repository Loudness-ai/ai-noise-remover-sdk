"""Trusted local executable benchmarks. Never accept manifests from untrusted uploads."""

import hashlib
import json
import math
import os
import platform
import statistics
import tempfile
import time
from dataclasses import replace
from pathlib import Path
from typing import Any

from ._process import run
from .analysis import analyze
from .comparison import compare
from .doctor import doctor
from .errors import AudioError
from .inspection import assert_source, source_file
from .options import Context, Json, Options, bounded, notify, options_for
from .policy import check_policy, evaluate


def file_sha256(path: Path, context: Context) -> str:
    hash_ = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1024 * 1024):
            context.check()
            hash_.update(block)
    return hash_.hexdigest()


def benchmark(manifest: Json, options: Options | None = None, **kwargs: Any) -> Json:
    opt = options_for(options, **kwargs)
    context = Context(opt)
    try:
        if len(json.dumps(manifest, allow_nan=False)) > 32 * 1024 * 1024:
            raise ValueError()
    except (TypeError, ValueError, RecursionError) as exc:
        raise AudioError(
            "BENCHMARK_INVALID", "A benchmark manifest must be finite JSON within 32 MiB."
        ) from exc
    if (
        not isinstance(manifest, dict)
        or type(manifest.get("schema_version")) is not int
        or manifest.get("schema_version") != 1
        or set(manifest)
        - {
            "schema_version",
            "fixtures",
            "processors",
            "repetitions",
            "warmup",
            "policy",
            "comparison",
        }
        or not isinstance(manifest.get("fixtures"), list)
        or not manifest["fixtures"]
        or not isinstance(manifest.get("processors"), list)
        or not manifest["processors"]
    ):
        raise AudioError("BENCHMARK_INVALID", "Invalid benchmark manifest.")
    repetitions, warmup = manifest.get("repetitions", 3), manifest.get("warmup", 1)
    bounded(repetitions, "repetitions", 1, 100, True)
    bounded(warmup, "warmup", 0, 100, True)
    if len(manifest["fixtures"]) * len(manifest["processors"]) * (repetitions + warmup) > 10000:
        raise AudioError("BENCHMARK_INVALID", "The manifest exceeds 10000 runs.")
    if "policy" in manifest:
        check_policy(manifest["policy"])
    if "comparison" in manifest and type(manifest["comparison"]) is not bool:
        raise AudioError("BENCHMARK_INVALID", "comparison must be boolean.")
    sources = []
    fixture_names: set[str] = set()
    for fixture in manifest["fixtures"]:
        if (
            not isinstance(fixture, dict)
            or set(fixture) != {"path", "sha256", "license"}
            or not isinstance(fixture["sha256"], str)
            or len(fixture["sha256"]) != 64
            or not isinstance(fixture["license"], str)
            or not fixture["license"]
        ):
            raise AudioError(
                "BENCHMARK_INVALID", "Each fixture requires path, SHA-256 and license."
            )
        path, identity = source_file(fixture["path"], opt, context)
        if path.name in fixture_names:
            raise AudioError(
                "BENCHMARK_INVALID", "Fixture filenames must be distinct for unambiguous results."
            )
        fixture_names.add(path.name)
        if file_sha256(path, context) != fixture["sha256"]:
            raise AudioError("FIXTURE_CHANGED", "Benchmark fixture checksum does not match.")
        sources.append((path, identity))
    names = set()
    for processor in manifest["processors"]:
        if (
            not isinstance(processor, dict)
            or set(processor) != {"name", "executable", "args", "version", "settings"}
            or any(
                not isinstance(processor[k], str) or not processor[k]
                for k in ("name", "executable", "version")
            )
            or not isinstance(processor["args"], list)
            or not all(isinstance(v, str) and "\0" not in v for v in processor["args"])
            or not isinstance(processor["settings"], dict)
            or processor["name"] in names
            or not any("{output}" in v for v in processor["args"])
            or not any("{input}" in v for v in processor["args"])
        ):
            raise AudioError(
                "BENCHMARK_INVALID",
                "Each trusted processor needs unique name, executable, input/output args, version and settings.",
            )
        names.add(processor["name"])
    runs = []
    quiet = replace(opt, on_progress=None)
    for path, identity in sources:
        for processor in manifest["processors"]:
            for repetition in range(-warmup, repetitions):
                context.check()
                assert_source(path, identity)
                notify(opt, "benchmark", None, processor=processor["name"], repetition=repetition)
                with tempfile.TemporaryDirectory(
                    prefix="loudness-benchmark-", dir=opt.temp_directory
                ) as directory:
                    output = Path(directory) / "output.wav"
                    args = [
                        v.replace("{input}", str(path)).replace("{output}", str(output))
                        for v in processor["args"]
                    ]
                    entry: Json = {
                        "fixture": path.name,
                        "processor": processor["name"],
                        "repetition": repetition,
                        "temperature": "first" if repetition == -warmup else "subsequent",
                    }
                    started = time.monotonic()
                    try:
                        measured = run(
                            processor["executable"], args, quiet, context, temp_paths=(output,)
                        )
                        analysis = analyze(output, quiet, _context=context)
                        assert_source(path, identity)
                        entry.update(
                            {
                                "state": "completed",
                                "metrics": measured["metrics"],
                                "analysis": analysis,
                                "scratch_audio_bytes": output.stat().st_size,
                            }
                        )
                        if "policy" in manifest:
                            entry["validation"] = evaluate(analysis, manifest["policy"])
                        if manifest.get("comparison"):
                            entry["comparison"] = compare(
                                path,
                                output,
                                replace(
                                    quiet,
                                    timeout_seconds=max(0.001, context.deadline - time.monotonic()),
                                ),
                            )
                    except AudioError as exc:
                        if exc.code in ("CANCELLED", "TIMEOUT"):
                            raise
                        entry.update(
                            {
                                "state": "failed",
                                "error": exc.to_dict(),
                                "wall_ms": (time.monotonic() - started) * 1000,
                            }
                        )
                    if repetition >= 0:
                        runs.append(entry)
    summaries = []
    for path, _ in sources:
        for name in names:
            selected = [r for r in runs if r["fixture"] == path.name and r["processor"] == name]
            values = sorted(r["metrics"]["wall_ms"] for r in selected if r["state"] == "completed")
            summaries.append(
                {
                    "fixture": path.name,
                    "processor": name,
                    "successes": len(values),
                    "failures": len(selected) - len(values),
                    "median_ms": statistics.median(values) if values else None,
                    "p95_ms": values[max(0, math.ceil(len(values) * 0.95) - 1)] if values else None,
                }
            )
    return {
        "schema_version": 1,
        "kind": "benchmark",
        "environment": {
            "platform": platform.system(),
            "arch": platform.machine(),
            "python": platform.python_version(),
            "cpu_count": os.cpu_count(),
            "native_versions": doctor(quiet, _context=context)["versions"],
        },
        "manifest": manifest,
        "runs": runs,
        "summaries": summaries,
        "limitations": [
            "Trusted executables only; this is not a sandbox.",
            "RSS is sampled, not an OS memory cap.",
            "Measured speed and quality are specific to this host and fixtures.",
        ],
    }
