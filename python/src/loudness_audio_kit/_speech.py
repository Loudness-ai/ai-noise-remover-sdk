"""The existing pinned graph contract, without any Node.js dependency."""

import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort

from .errors import AudioError

FRAME_SIZE = 512
SPEECH_RATE = 48000
DELAY_FRAMES = 3
MODEL_HASH = "b758c49d6708a5b7979e3de185705a8a4915076c862fb17b1b304d9a72b75cdc"
STATE_HASH = "7664728d90e7b17655cf4d308d46d42fdea6c3a69c374e494164c7cb44d783fc"
MODEL_DIR = Path(__file__).parent / "models" / "dfn3-512-v1"


class SpeechEngine:
    def __init__(self, directory: Path, channels: int, threads: int):
        assets = {}
        try:
            for name, maximum in [
                ("denoiser_model.onnx", 12911035),
                ("initial_states.bin", 184544),
                ("initial_states.json", 16384),
                ("meta.json", 16384),
            ]:
                path = directory / name
                if not path.is_file() or path.stat().st_size > maximum:
                    raise AudioError("MODEL_INVALID", "A local speech asset has an invalid size.")
                # Bounded read also handles a replacement between stat and read.
                with path.open("rb") as handle:
                    data = handle.read(maximum + 1)
                if len(data) > maximum:
                    raise AudioError(
                        "MODEL_INVALID", "A local speech asset exceeds its size limit."
                    )
                assets[name] = data
        except OSError as exc:
            raise AudioError("MODEL_MISSING", "The local speech model assets are missing.") from exc
        if (
            hashlib.sha256(assets["denoiser_model.onnx"]).hexdigest() != MODEL_HASH
            or hashlib.sha256(assets["initial_states.bin"]).hexdigest() != STATE_HASH
        ):
            raise AudioError("MODEL_INVALID", "The local speech asset checksum does not match.")
        try:
            manifest = json.loads(assets["initial_states.json"])
            meta = json.loads(assets["meta.json"])
            inputs, outputs, records = meta["input_names"], meta["output_names"], manifest["states"]
            if (
                len(inputs) != 13
                or len(outputs) != 13
                or len(records) != 12
                or inputs[0] != "input_frame"
                or outputs[0] != "enhanced_audio_frame"
                or manifest["bytes"] != 184544
                or manifest["sha256"] != STATE_HASH
                or meta["sample_rate"] != SPEECH_RATE
                or meta["frame_size"] != FRAME_SIZE
            ):
                raise ValueError()
            offset = 0
            for i, record in enumerate(records):
                shape = record["shape"]
                if (
                    not isinstance(shape, list)
                    or not shape
                    or not all(type(n) is int and 0 < n <= 4096 for n in shape)
                    or record["name"] != inputs[i + 1]
                    or outputs[i + 1] != "new_" + record["name"]
                    or record["offset"] != offset
                    or record["bytes"] != int(np.prod(shape)) * 4
                ):
                    raise ValueError()
                offset += record["bytes"]
            if offset != len(assets["initial_states.bin"]):
                raise ValueError()
        except (ValueError, TypeError, KeyError, IndexError) as exc:
            raise AudioError("MODEL_INVALID", "The speech state manifest is invalid.") from exc
        ort.disable_telemetry_events()
        settings = ort.SessionOptions()
        settings.intra_op_num_threads = threads
        settings.inter_op_num_threads = 1
        settings.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        settings.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        try:
            self.session: Any = ort.InferenceSession(
                assets["denoiser_model.onnx"],
                sess_options=settings,
                providers=["CPUExecutionProvider"],
            )
        except Exception as exc:
            raise AudioError(
                "MODEL_INVALID", "Could not initialize the local speech graph."
            ) from exc
        if [i.name for i in self.session.get_inputs()] != inputs or [
            o.name for o in self.session.get_outputs()
        ] != outputs:
            raise AudioError("MODEL_INVALID", "The speech graph contract does not match.")
        self.input_names = inputs
        self.states = [
            {
                r["name"]: np.frombuffer(
                    assets["initial_states.bin"],
                    dtype="<f4",
                    count=r["bytes"] // 4,
                    offset=r["offset"],
                )
                .reshape(r["shape"])
                .copy()
                for r in records
            }
            for _ in range(channels)
        ]

    def frame(self, samples: Any, channel: int) -> Any:
        if (
            samples.shape != (FRAME_SIZE,)
            or samples.dtype != np.float32
            or not 0 <= channel < len(self.states)
        ):
            raise AudioError("PCM_INVALID", "Invalid speech frame.")
        try:
            result = self.session.run(None, {"input_frame": samples, **self.states[channel]})
        except Exception as exc:
            raise AudioError(
                "INFERENCE_FAILED", "The local speech engine could not process this frame."
            ) from exc
        wet = np.asarray(result[0], dtype=np.float32)
        if wet.shape != (FRAME_SIZE,) or not np.isfinite(wet).all():
            raise AudioError("PCM_INVALID", "The speech engine returned invalid samples.")
        self.states[channel] = dict(zip(self.input_names[1:], result[1:], strict=True))
        return wet.copy()

    def close(self) -> None:
        self.states.clear()
        self.session = None
