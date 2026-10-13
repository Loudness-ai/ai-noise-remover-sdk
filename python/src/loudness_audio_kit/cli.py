"""CLI with structured results and SIGINT cancellation cleanup."""

import argparse
import json
import signal
import sys
from pathlib import Path
from typing import Any

from .analysis import analyze
from .benchmark import benchmark
from .client import batch, process_batch
from .comparison import compare
from .doctor import doctor, processing_doctor
from .errors import AudioError, CancellationToken
from .inspection import inspect
from .options import Options
from .policy import EXAMPLE_POLICY, validate
from .processing import process_audio
from .report import render_report


def read_json(path: str) -> Any:
    try:
        with open(path, "rb") as handle:
            content = handle.read(32 * 1024 * 1024 + 1)
        if len(content) > 32 * 1024 * 1024:
            raise ValueError()
        value = json.loads(content, parse_constant=lambda _v: (_ for _ in ()).throw(ValueError()))
        # Newer interpreters can decode arbitrarily deep JSON without RecursionError.
        # Bound structure explicitly and traverse iterators rather than copying children.
        pending = [iter((value,))]
        while pending:
            try:
                child = next(pending[-1])
            except StopIteration:
                pending.pop()
                continue
            if isinstance(child, (dict, list)):
                if len(pending) > 128:
                    raise ValueError()
                pending.append(iter(child.values() if isinstance(child, dict) else child))
        return value
    except (OSError, ValueError, RecursionError) as exc:
        raise AudioError(
            "JSON_INVALID", "Could not read finite JSON within 32 MiB and 128 nested levels."
        ) from exc


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(
        prog="loudness-audio", description="Local speech processing and audio measurement."
    )
    root.add_argument("--version", action="version", version="loudness-audio-kit 1.0.1")
    subs = root.add_subparsers(dest="command", required=True)
    for name in (
        "denoise",
        "enhance",
        "normalize",
        "convert",
        "inspect",
        "analyze",
        "validate",
        "compare",
        "batch",
        "process-batch",
        "benchmark",
        "doctor",
        "processing-doctor",
        "report",
        "example-policy",
    ):
        p = subs.add_parser(name)
        if name in ("denoise", "enhance", "normalize", "convert", "inspect", "analyze", "validate"):
            p.add_argument("input")
        if name in ("denoise", "enhance", "normalize", "convert"):
            p.add_argument("--output", required=True)
        if name == "validate":
            p.add_argument("--policy", required=True)
        if name == "compare":
            p.add_argument("before")
            p.add_argument("after")
            p.add_argument("--tolerance-seconds", type=float, default=0.05)
            p.add_argument("--max-alignment-seconds", type=float, default=0.5)
        if name == "batch":
            p.add_argument("inputs", nargs="+")
        if name in ("process-batch", "benchmark", "report"):
            p.add_argument("input", help="JSON jobs, benchmark manifest or report")
        if name == "report":
            p.add_argument("--output", required=True)
            p.add_argument("--title", default="Loudness.ai Audio Report")
        if name in ("batch", "process-batch"):
            p.add_argument("--concurrency", type=int)
            p.add_argument("--total-memory-budget-mib", type=int)
            p.add_argument("--cpu-thread-budget", type=int)
            p.add_argument("--max-queued", type=int, default=10000)
            if name == "process-batch":
                p.add_argument("--fail-fast", action="store_true")
        p.add_argument("--overwrite", action="store_true")
        p.add_argument("--progress", action="store_true", help="Write progress JSON to stderr")
        for flag in (
            "max-file-bytes",
            "max-temp-bytes",
            "memory-budget-mib",
            "native-threads",
            "stream-index",
            "sample-rate",
            "channels",
            "bit-depth",
            "bitrate-kbps",
            "max-points",
            "max-events",
        ):
            p.add_argument("--" + flag, type=int)
        for flag in (
            "timeout-seconds",
            "max-duration-seconds",
            "strength",
            "target-lufs",
            "true-peak-dbtp",
            "loudness-range-lu",
            "silence-threshold-dbfs",
            "min-silence-seconds",
            "clipping-threshold",
            "discontinuity-threshold",
        ):
            p.add_argument("--" + flag, type=float)
        for flag in ("format", "temp-directory", "model-dir", "ffmpeg-path", "ffprobe-path"):
            p.add_argument("--" + flag)
        p.add_argument("--no-normalize", action="store_true")
        p.add_argument("--no-voice-processing", action="store_true")
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    token = CancellationToken()
    received_signal: int = signal.SIGINT
    previous = {s: signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM)}

    def stop(signum: int, _frame: Any) -> None:
        nonlocal received_signal
        received_signal = signum
        token.cancel()

    for s in previous:
        signal.signal(s, stop)
    try:
        allowed = set(Options.__dataclass_fields__)
        values = {
            key: value for key, value in vars(args).items() if key in allowed and value is not None
        }
        values["cancel_token"] = token
        if args.no_normalize:
            values["normalize"] = False
        if args.no_voice_processing:
            values["voice_processing"] = False
        if args.progress:
            values["on_progress"] = lambda event: print(
                json.dumps(event, allow_nan=False), file=sys.stderr, flush=True
            )
        opt = Options(**values)
        command = args.command
        result: Any
        if command in ("denoise", "enhance", "normalize", "convert"):
            result = process_audio(args.input, args.output, command, opt)
        elif command in ("inspect", "analyze"):
            result = (inspect if command == "inspect" else analyze)(args.input, opt)
        elif command == "validate":
            result = validate(args.input, read_json(args.policy), opt)
        elif command == "compare":
            result = compare(
                args.before,
                args.after,
                opt,
                tolerance_seconds=args.tolerance_seconds,
                max_alignment_seconds=args.max_alignment_seconds,
            )
        elif command in ("batch", "process-batch"):
            pool = {
                k: getattr(args, k)
                for k in (
                    "concurrency",
                    "total_memory_budget_mib",
                    "cpu_thread_budget",
                    "max_queued",
                )
            }
            result = (
                batch(args.inputs, opt, **pool)
                if command == "batch"
                else process_batch(read_json(args.input), opt, fail_fast=args.fail_fast, **pool)
            )
        elif command == "benchmark":
            result = benchmark(read_json(args.input), opt)
        elif command in ("doctor", "processing-doctor"):
            result = (doctor if command == "doctor" else processing_doctor)(opt)
        elif command == "report":
            content = render_report(read_json(args.input), title=args.title)
            with Path(args.output).open("w" if args.overwrite else "x") as output:
                output.write(content)
            result = {"path": str(Path(args.output).absolute())}
        else:
            result = EXAMPLE_POLICY
        print(json.dumps(result, allow_nan=False, indent=2))
        if isinstance(result, dict) and (
            result.get("failed")
            or result.get("ready") is False
            or any(r.get("state") != "completed" for r in result.get("results", []) if "state" in r)
        ):
            return 2
        return 0
    except AudioError as exc:
        print(json.dumps({"error": exc.to_dict()}), file=sys.stderr)
        return 128 + received_signal if exc.code == "CANCELLED" else 1
    except (OSError, TypeError, ValueError):
        error = AudioError("CLI_INVALID", "The command could not read or write its local files.")
        print(json.dumps({"error": error.to_dict()}), file=sys.stderr)
        return 1
    finally:
        for s, handler in previous.items():
            signal.signal(s, handler)
