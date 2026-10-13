"""Optional development comparison against the delivered JavaScript kit."""

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

import numpy as np

from loudness_audio_kit import analyze, denoise, enhance

parser = argparse.ArgumentParser()
parser.add_argument("--node-kit", type=Path, required=True)
parser.add_argument("--receipt", type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
results = []
with tempfile.TemporaryDirectory(prefix="kit-python-parity-") as directory:
    directory = Path(directory)
    node_script = directory / "consumer.cjs"
    node_script.write_text(
        "const kit=require(process.argv[2]);kit[process.argv[3]](process.argv[4],process.argv[5]).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.code,e.message);process.exit(1)});"
    )
    for fixture in ("narration-a.ogg", "narration-b.ogg"):
        source = root / "examples" / "fixtures" / fixture
        for mode, processor in (("denoise", denoise), ("enhance", enhance)):
            py_out, js_out = directory / "python.wav", directory / "node.wav"
            py_result = processor(source, py_out, overwrite=True)
            js_out.unlink(missing_ok=True)
            node_result = json.loads(
                subprocess.check_output(
                    [
                        "node",
                        str(node_script),
                        str(args.node_kit.resolve() / "dist" / "cjs" / "index.js"),
                        mode,
                        str(source),
                        str(js_out),
                    ],
                    text=True,
                )
            )

            def decode(path):
                return np.frombuffer(
                    subprocess.check_output(
                        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "pipe:1"]
                    ),
                    dtype="<f4",
                )

            py_pcm, js_pcm = decode(py_out), decode(js_out)
            assert len(py_pcm) == len(js_pcm)
            delta = float(np.max(np.abs(py_pcm - js_pcm)))
            assert delta <= 1 / 32768, delta
            for py_key, js_key in (
                ("integrated_lufs", "integratedLufs"),
                ("true_peak_dbtp", "truePeakDbtp"),
                ("rms_dbfs", "rmsDbfs"),
                ("sample_peak_dbfs", "samplePeakDbfs"),
            ):
                a, b = py_result["analysis"][py_key], node_result["analysis"][js_key]
                assert (
                    a is None
                    and b is None
                    or a is not None
                    and b is not None
                    and abs(a - b) < 0.001
                ), (py_key, a, b)
            results.append(
                {
                    "fixture": fixture,
                    "mode": mode,
                    "frames": len(py_pcm),
                    "max_pcm_difference": delta,
                    "python_wall_ms": py_result["metrics"]["wall_ms"],
                    "node_wall_ms": node_result["metrics"]["wallMs"],
                    "python_child_peak_rss_bytes": py_result["metrics"][
                        "sampled_peak_tree_rss_bytes"
                    ],
                    "passed": True,
                }
            )
    measured = analyze(root / "examples" / "fixtures" / "narration-a.ogg")
    assert measured["duration_seconds"] > 14
args.receipt.parent.mkdir(parents=True, exist_ok=True)
args.receipt.write_text(
    json.dumps(
        {
            "passed": True,
            "comparisons": results,
            "limitation": "Same existing engine and host; this checks port parity, not superiority.",
        },
        indent=2,
    )
)
print(json.dumps(results, indent=2))
