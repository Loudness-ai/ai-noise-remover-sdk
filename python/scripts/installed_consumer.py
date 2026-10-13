"""Run outside the source checkout against an installed wheel or source archive."""

import json
import platform
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import loudness_audio_kit as kit

with tempfile.TemporaryDirectory(prefix="installed-python-kit-") as directory:
    directory = Path(directory)
    source = directory / "source.wav"
    with wave.open(str(source), "wb") as recording:
        recording.setparams((1, 2, 48000, 0, "NONE", "not compressed"))
        recording.writeframes(b"\0" * 96000)
    for mode in ("denoise", "enhance", "normalize", "convert"):
        result = getattr(kit, mode)(source, directory / (mode + ".wav"))
        assert result["analysis"]["frames"] == 48000
        cli = subprocess.run(
            [
                sys.executable,
                "-m",
                "loudness_audio_kit",
                mode,
                str(source),
                "--output",
                str(directory / (mode + "-cli.wav")),
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        assert json.loads(cli.stdout)["analysis"]["frames"] == 48000
    assert kit.processing_doctor()["ready"]
    assert kit.compare(source, source)["decoded_pcm_equal"]
    assert "<html" in kit.render_report(kit.analyze(source))
    batch = kit.process_batch(
        [{"input": str(source), "output": str(directory / "batch.wav"), "mode": "denoise"}]
    )
    assert batch["results"][0]["state"] == "completed"
    print(
        json.dumps(
            {
                "passed": True,
                "version": kit.__version__,
                "python": platform.python_version(),
                "platform": platform.platform(),
                "module": kit.__file__,
                "requires_node": False,
                "local_processing": True,
            },
            indent=2,
        )
    )
