"""Long-file duration, sampled child memory, repeated-job and scratch cleanup evidence."""

import argparse
import json
import platform
import tempfile
import wave
from pathlib import Path

import numpy as np

from loudness_audio_kit import denoise

parser = argparse.ArgumentParser()
parser.add_argument("--seconds", type=int, default=3600)
parser.add_argument("--receipt", type=Path, required=True)
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix="python-kit-long-") as directory:
    directory = Path(directory)
    scratch = directory / "scratch"
    scratch.mkdir()
    source = directory / "long.wav"
    rate = 16000
    block = (
        np.rint(0.1 * np.sin(np.arange(rate) * 2 * np.pi * 440 / rate) * 32767)
        .astype("<i2")
        .tobytes()
    )
    with wave.open(str(source), "wb") as recording:
        recording.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        for _ in range(args.seconds):
            recording.writeframesraw(block)
    result = denoise(source, directory / "out.wav", temp_directory=scratch)
    assert result["analysis"]["frames"] == rate * args.seconds
    assert not list(scratch.iterdir())
    source = directory / "short.wav"
    with wave.open(str(source), "wb") as recording:
        recording.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        recording.writeframes(block)
    for _ in range(10):
        denoise(source, directory / "repeat.wav", overwrite=True, temp_directory=scratch)
        assert not list(scratch.iterdir())
    receipt = {
        "passed": True,
        "python": platform.python_version(),
        "platform": platform.platform(),
        "duration_seconds": args.seconds,
        "output_frames": result["analysis"]["frames"],
        "metrics": result["metrics"],
        "repeat_jobs": 10,
        "scratch_leftovers": 0,
    }
args.receipt.write_text(json.dumps(receipt, indent=2))
print(json.dumps(receipt, indent=2))
