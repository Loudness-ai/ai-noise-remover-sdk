"""Run: python examples/batch.py /existing/output/directory a.wav b.mp3"""

import argparse
import json
from pathlib import Path

from loudness_audio_kit import process_batch

parser = argparse.ArgumentParser()
parser.add_argument("directory", type=Path)
parser.add_argument("inputs", type=Path, nargs="+")
args = parser.parse_args()
jobs = [
    {
        "input": str(source),
        "output": str(args.directory / f"{i:04d}-{source.stem}.wav"),
        "mode": "enhance",
    }
    for i, source in enumerate(args.inputs)
]
result = process_batch(
    jobs,
    concurrency=4,
    total_memory_budget_mib=2048,
    cpu_thread_budget=4,
    max_queued=100,
    max_duration_seconds=3600,
    timeout_seconds=900,
)
print(json.dumps(result, indent=2))
