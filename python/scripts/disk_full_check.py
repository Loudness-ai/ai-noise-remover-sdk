"""Run installed in a container with /space mounted as a 2 MiB writable tmpfs."""

import json
import tempfile
import wave
from pathlib import Path

from loudness_audio_kit import AudioError, denoise

space = Path("/space")
assert space.is_dir() and not list(space.iterdir())
with tempfile.TemporaryDirectory(prefix="disk-full-input-") as directory:
    source = Path(directory) / "input.wav"
    with wave.open(str(source), "wb") as recording:
        recording.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        recording.writeframes(b"\0" * 16000 * 2 * 20)
    original = source.read_bytes()
    try:
        denoise(source, space / "out.wav", temp_directory=space)
        raise AssertionError("Expected physical filesystem exhaustion")
    except AudioError as error:
        assert error.code == "OUTPUT_SPACE", error.to_dict()
        assert not list(space.iterdir())
        assert source.read_bytes() == original
        print(
            json.dumps(
                {
                    "passed": True,
                    "error_code": error.code,
                    "scratch_leftovers": 0,
                    "partial_output": False,
                    "filesystem_capacity_bytes": 2 * 1024**2,
                }
            )
        )
