"""Run: python examples/basic.py recording.wav /existing/output/directory"""

import argparse
import json
from pathlib import Path

from loudness_audio_kit import Options, analyze, denoise, enhance, render_report

parser = argparse.ArgumentParser()
parser.add_argument("input", type=Path)
parser.add_argument("directory", type=Path)
args = parser.parse_args()
limits = Options(max_duration_seconds=3600, timeout_seconds=900)
clean = denoise(args.input, args.directory / "denoised.wav", limits)
finished = enhance(args.input, args.directory / "enhanced.wav", limits)
analysis = analyze(finished["output"]["path"], limits)
with (args.directory / "report.html").open("x") as report:
    report.write(render_report(analysis))
print(json.dumps({"denoised": clean["output"], "enhanced": finished["output"]}, indent=2))
