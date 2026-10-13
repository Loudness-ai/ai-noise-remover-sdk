"""Isolated inference process. Decoder inherits its owned process group."""

import json
import os
import subprocess
import sys
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

import numpy as np

from ._process import translate_os_error
from ._speech import DELAY_FRAMES, FRAME_SIZE, SpeechEngine
from .errors import AudioError
from .inspection import MEDIA_FORMATS


def emit(value: dict[str, Any]) -> None:
    print(json.dumps(value, allow_nan=False), flush=True)


def main(config: dict[str, Any]) -> None:
    started = time.monotonic()
    emit({"phase": "initialize", "fraction": None})
    engine = None
    decoder = None
    reader = None
    stderr = bytearray()
    frames = written = 0
    dry_queue: deque[tuple[Any, int]] = deque()
    rate, channels = config["sample_rate"], config["channels"]
    block_bytes = FRAME_SIZE * channels * 4
    try:
        if config["neural"] and config["strength"] > 0:
            engine = SpeechEngine(Path(config["model_dir"]), channels, config["threads"])
        initialized_ms = (time.monotonic() - started) * 1000
        try:
            decoder = subprocess.Popen(
                [
                    config["ffmpeg"],
                    "-nostdin",
                    "-v",
                    "error",
                    "-xerror",
                    "-threads",
                    str(config["threads"]),
                    "-filter_threads",
                    "1",
                    "-protocol_whitelist",
                    "file,pipe",
                    "-format_whitelist",
                    MEDIA_FORMATS,
                    "-i",
                    config["input"],
                    "-map",
                    f"0:{config['stream_index']}",
                    "-vn",
                    "-sn",
                    "-dn",
                    "-ar",
                    str(rate),
                    "-ac",
                    str(channels),
                    "-f",
                    "f32le",
                    "-acodec",
                    "pcm_f32le",
                    "pipe:1",
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                shell=False,
            )
        except OSError as exc:
            raise AudioError("DEPENDENCY_MISSING", "Could not start the audio decoder.") from exc

        def consume_error() -> None:
            assert decoder is not None and decoder.stderr is not None
            while True:
                data = decoder.stderr.read(8192)
                if not data:
                    break
                stderr.extend(data)
                if len(stderr) > 8192:
                    del stderr[:-8192]

        reader = threading.Thread(target=consume_error, daemon=True)
        reader.start()
        last_progress = 0.0
        with open(config["output"], "xb") as target:
            os.chmod(config["output"], 0o600)

            def write(wet: Any, count: int) -> None:
                nonlocal written
                if (written + count) * channels * 4 > config["max_temp_bytes"]:
                    raise AudioError(
                        "TEMP_LIMIT", "Decoded audio exceeds the temporary-disk budget."
                    )
                target.write(np.asarray(wet[:, :count].T, dtype="<f4").tobytes())
                written += count

            def output_frame(wet: Any) -> None:
                previous, count = dry_queue.popleft()
                blended = config["strength"] * wet + (1 - config["strength"]) * previous
                write(blended, count)

            assert decoder.stdout is not None
            while True:
                data = decoder.stdout.read(block_bytes)
                if not data:
                    break
                if len(data) % (channels * 4):
                    raise AudioError(
                        "PCM_INVALID", "The decoded audio ends with an incomplete sample."
                    )
                count = len(data) // channels // 4
                if (frames + count) / rate > config["max_duration"] + 1 / rate:
                    raise AudioError(
                        "DURATION_LIMIT", "Decoded audio exceeds the configured duration limit."
                    )
                dry = np.zeros((channels, FRAME_SIZE), dtype=np.float32)
                dry[:, :count] = np.frombuffer(data, dtype="<f4").reshape(count, channels).T
                if not np.isfinite(dry).all():
                    raise AudioError("PCM_INVALID", "The recording contains non-finite samples.")
                if engine:
                    wet = np.stack([engine.frame(dry[ch], ch) for ch in range(channels)])
                    if len(dry_queue) == DELAY_FRAMES:
                        output_frame(wet)
                    dry_queue.append((dry, count))
                else:
                    write(dry, count)
                frames += count
                now = time.monotonic()
                if now - last_progress > 0.25:
                    duration = config["declared_duration"]
                    emit(
                        {
                            "phase": "denoise" if config["neural"] else "decode",
                            "fraction": min(0.99, frames / rate / duration) if duration else None,
                            "decoded_seconds": frames / rate,
                        }
                    )
                    last_progress = now
            if decoder.wait() != 0:
                raise AudioError("DECODE_FAILED", "The input could not be decoded completely.")
            if not frames:
                raise AudioError("PCM_INVALID", "The recording contains no audio samples.")
            if engine:
                processed_blocks = (frames + FRAME_SIZE - 1) // FRAME_SIZE
                for flush in range(DELAY_FRAMES):
                    wet = np.stack(
                        [
                            engine.frame(np.zeros(FRAME_SIZE, dtype=np.float32), ch)
                            for ch in range(channels)
                        ]
                    )
                    if processed_blocks + flush >= DELAY_FRAMES and dry_queue:
                        output_frame(wet)
            if written != frames:
                raise AudioError(
                    "OUTPUT_INVALID", "The processed recording has an unexpected sample count."
                )
            target.flush()
            os.fsync(target.fileno())
        emit(
            {
                "kind": "worker-result",
                "frames": written,
                "sample_rate": rate,
                "channels": channels,
                "initialized_ms": initialized_ms,
                "wall_ms": (time.monotonic() - started) * 1000,
                "delay_compensated_samples": DELAY_FRAMES * FRAME_SIZE if engine else 0,
            }
        )
    finally:
        if decoder:
            if decoder.poll() is None:
                decoder.kill()
            decoder.wait()
            if reader:
                reader.join()
            if decoder.stdout:
                decoder.stdout.close()
            if decoder.stderr:
                decoder.stderr.close()
        if engine:
            engine.close()


if __name__ == "__main__":
    try:
        main(json.loads(Path(sys.argv[1]).read_text()))
    except Exception as exc:
        error = (
            exc
            if isinstance(exc, AudioError)
            else translate_os_error(exc)
            if isinstance(exc, OSError)
            else AudioError("WORKER_FAILED", "The local speech worker failed.")
        )
        emit({"kind": "worker-error", **error.to_dict()})
        sys.exit(1)
