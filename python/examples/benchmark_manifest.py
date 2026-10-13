"""Generate trusted manifest: python examples/benchmark_manifest.py > manifest.json"""

import hashlib
import json
import sys
from pathlib import Path

fixture = Path(__file__).parent / "fixtures" / "narration-a.ogg"
manifest = {
    "schema_version": 1,
    "fixtures": [
        {
            "path": str(fixture.resolve()),
            "sha256": hashlib.sha256(fixture.read_bytes()).hexdigest(),
            "license": "CC-BY-4.0; see examples/fixtures/provenance.json",
        }
    ],
    "processors": [
        {
            "name": "python-denoise",
            "executable": sys.executable,
            "args": ["-m", "loudness_audio_kit", "denoise", "{input}", "--output", "{output}"],
            "version": "loudness-audio-kit 1.0.0",
            "settings": {"mode": "denoise", "strength": 1, "native_threads": 1},
        }
    ],
    "warmup": 1,
    "repetitions": 3,
    "comparison": True,
}
print(json.dumps(manifest, indent=2))
