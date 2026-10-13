import subprocess
import wave
from pathlib import Path
from typing import Any

import numpy as np
import pytest


def write_wav(path: Path, audio: Any, rate: int = 48000) -> Path:
    audio = np.asarray(audio)
    if audio.ndim == 1:
        audio = audio[:, None]
    with wave.open(str(path), "wb") as recording:
        recording.setparams((audio.shape[1], 2, rate, 0, "NONE", "not compressed"))
        recording.writeframes(np.rint(np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
    return path


def decode(path: Path, rate: int | None = None) -> Any:
    args = ["ffmpeg", "-v", "error", "-i", str(path)]
    if rate:
        args += ["-ar", str(rate)]
    data = subprocess.check_output([*args, "-f", "f32le", "pipe:1"])
    return np.frombuffer(data, dtype="<f4")


@pytest.fixture
def tone(tmp_path: Path) -> Path:
    t = np.arange(144000) / 48000
    return write_wav(tmp_path / "source.wav", 0.12 * np.sin(2 * np.pi * 440 * t))


@pytest.fixture
def speech(tmp_path: Path) -> tuple[Path, Any]:
    clean = decode(
        Path(__file__).resolve().parents[1] / "examples" / "fixtures" / "narration-a.ogg", 48000
    )
    rng = np.random.default_rng(99)
    noise = rng.standard_normal(len(clean))
    noise *= np.sqrt(np.mean(clean**2) / 10 / np.mean(noise**2))
    return write_wav(tmp_path / "noisy.wav", clean + noise), clean
