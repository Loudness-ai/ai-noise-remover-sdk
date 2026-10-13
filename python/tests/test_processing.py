import asyncio
import json
import os
import time

import numpy as np
import onnxruntime as ort
import pytest
from conftest import decode, write_wav

from loudness_audio_kit import (
    AudioError,
    CancellationToken,
    analyze,
    convert,
    denoise,
    enhance,
    normalize,
    process_audio_async,
    processing_doctor,
)
from loudness_audio_kit._speech import MODEL_DIR


@pytest.mark.parametrize("frames", [1, 17, 511, 512, 513, 1535, 1536, 1537, 48017])
def test_full_duration_including_subframe_and_tail(tmp_path, frames):
    source = write_wav(tmp_path / "in.wav", np.sin(np.arange(frames) * 0.13) * 0.1)
    output = tmp_path / "out.wav"
    result = denoise(source, output)
    assert len(decode(output)) == frames
    assert result["analysis"]["frames"] == frames
    assert result["output"]["duration_seconds"] == frames / 48000
    assert not list(tmp_path.glob(".loudness*"))


def test_noisy_speech_quality_alignment_and_tail(speech, tmp_path):
    source, clean = speech
    output = tmp_path / "clean.wav"
    denoise(source, output)
    actual = decode(output).astype(np.float64)
    assert len(actual) == len(clean)
    scale = np.dot(actual, clean) / np.dot(clean, clean)
    score = 10 * np.log10(np.sum((scale * clean) ** 2) / np.sum((actual - scale * clean) ** 2))
    assert score > 16, score
    assert np.sum(actual[-4800:] ** 2) > 0.001


def test_independent_whole_buffer_reference(speech, tmp_path):
    source, _ = speech
    source_samples = decode(source)
    manifest = json.loads((MODEL_DIR / "initial_states.json").read_text())
    blob = (MODEL_DIR / "initial_states.bin").read_bytes()
    states = {
        r["name"]: np.frombuffer(blob, dtype="<f4", offset=r["offset"], count=r["bytes"] // 4)
        .reshape(r["shape"])
        .copy()
        for r in manifest["states"]
    }
    settings = ort.SessionOptions()
    settings.intra_op_num_threads = 1
    session = ort.InferenceSession(
        str(MODEL_DIR / "denoiser_model.onnx"), settings, providers=["CPUExecutionProvider"]
    )
    names = [i.name for i in session.get_inputs()][1:]
    padded = np.pad(source_samples, (0, (-len(source_samples)) % 512 + 1536))
    blocks = []
    for i in range(0, len(padded), 512):
        values = session.run(None, {"input_frame": padded[i : i + 512], **states})
        blocks.append(values[0])
        states = dict(zip(names, values[1:], strict=True))
    reference = np.concatenate(blocks)[1536 : 1536 + len(source_samples)]
    output = tmp_path / "out.wav"
    denoise(source, output)
    assert np.max(np.abs(decode(output) - reference)) <= 1 / 32768


@pytest.mark.parametrize("mode", [denoise, enhance, normalize, convert])
def test_modes_produce_verified_audio(tone, tmp_path, mode):
    r = mode(tone, tmp_path / "out.wav")
    assert r["output"]["duration_seconds"] == 3
    assert r["output"]["sample_rate"] == 48000
    assert r["analysis"]["frames"] == 144000
    assert r["metrics"]["sampled_peak_tree_rss_bytes"] > 0


@pytest.mark.parametrize(
    "format_,depth",
    [("wav", 16), ("wav", 24), ("flac", 16), ("flac", 24), ("mp3", 16), ("opus", 16)],
)
def test_export_formats(tone, tmp_path, format_, depth):
    out = tmp_path / ("out." + format_)
    r = convert(tone, out, bit_depth=depth)
    assert r["output"]["format"] == format_
    assert abs(r["output"]["duration_seconds"] - 3) < 0.06
    assert out.stat().st_size > 100


@pytest.mark.parametrize("rate", [8000, 16000, 44100, 96000])
def test_preserves_input_sample_rate(tmp_path, rate):
    source = write_wav(tmp_path / "in.wav", np.sin(np.arange(rate) * 0.06) * 0.1, rate)
    result = denoise(source, tmp_path / "out.wav")
    assert result["analysis"]["frames"] == rate
    assert result["output"]["sample_rate"] == rate


def test_channel_state_isolation(tmp_path):
    x = np.sin(np.arange(48000) * 0.07) * 0.15
    stereo = write_wav(tmp_path / "stereo.wav", np.column_stack([x, np.zeros(len(x))]))
    mono = write_wav(tmp_path / "mono.wav", x)
    denoise(stereo, tmp_path / "stereo-out.wav")
    denoise(mono, tmp_path / "mono-out.wav")
    actual = decode(tmp_path / "stereo-out.wav").reshape(-1, 2)
    assert np.max(np.abs(actual[:, 0] - decode(tmp_path / "mono-out.wav"))) <= 1 / 32768
    assert np.max(np.abs(actual[:, 1])) == 0


def test_normalization_target_and_silent_skip(tone, tmp_path):
    out = tmp_path / "level.wav"
    r = normalize(tone, out, target_lufs=-18, true_peak_dbtp=-2)
    assert abs(r["analysis"]["integrated_lufs"] + 18) < 0.3
    assert r["analysis"]["true_peak_dbtp"] <= -1.8
    silent = write_wav(tmp_path / "silent.wav", np.zeros(48000))
    r = enhance(silent, tmp_path / "silence-out.wav")
    assert r["analysis"]["state"] == "silent"
    assert not r["settings"]["normalized"] and r["warnings"]


def test_strength_zero_identity(tone, tmp_path):
    r = denoise(tone, tmp_path / "out.wav", strength=0)
    assert r["analysis"]["decoded_pcm_sha256"] == analyze(tone)["decoded_pcm_sha256"]


@pytest.mark.parametrize(
    "kwargs,code",
    [
        ({"max_file_bytes": 100}, "FILE_LIMIT"),
        ({"max_duration_seconds": 1}, "DURATION_LIMIT"),
        ({"max_temp_bytes": 1024}, "TEMP_LIMIT"),
        ({"memory_budget_mib": 32}, "MEMORY_LIMIT"),
        ({"timeout_seconds": 0.001}, "TIMEOUT"),
    ],
)
def test_resource_limits_and_cleanup(tone, tmp_path, kwargs, code):
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    with pytest.raises(AudioError) as error:
        denoise(tone, tmp_path / "out.wav", temp_directory=scratch, **kwargs)
    assert error.value.code == code
    assert not (tmp_path / "out.wav").exists()
    assert not list(scratch.iterdir()) and not list(tmp_path.glob(".loudness*"))


@pytest.mark.parametrize(
    "phase", ["inspect", "initialize", "denoise", "normalize", "export", "verify"]
)
def test_cancellation_at_phases(tone, tmp_path, phase):
    token = CancellationToken()
    phases = []

    def progress(event):
        phases.append(event["phase"])
        if event["phase"] == phase:
            token.cancel()

    with pytest.raises(AudioError) as error:
        enhance(
            tone,
            tmp_path / "out.wav",
            cancel_token=token,
            on_progress=progress,
            temp_directory=tmp_path,
        )
    assert error.value.code == "CANCELLED"
    assert phase in phases
    assert sorted(p.name for p in tmp_path.iterdir()) == ["source.wav"]


def test_observer_error_stops_and_postcommit_observer_cannot_fail(tone, tmp_path):
    def fail(event):
        if event["phase"] == "denoise":
            raise RuntimeError("observer")

    with pytest.raises(AudioError, match="callback") as error:
        denoise(tone, tmp_path / "out.wav", on_progress=fail)
    assert error.value.code == "OBSERVER_ERROR" and not (tmp_path / "out.wav").exists()

    def fail_complete(event):
        if event["phase"] == "complete":
            raise RuntimeError("already committed")

    assert (
        denoise(tone, tmp_path / "out.wav", on_progress=fail_complete)["output"]["name"]
        == "out.wav"
    )


def test_output_protection_and_overwrite(tone, tmp_path):
    original = tone.read_bytes()
    with pytest.raises(AudioError) as error:
        convert(tone, tone, overwrite=True)
    assert error.value.code == "OUTPUT_CLOBBER"
    alias = tmp_path / "alias.wav"
    os.link(tone, alias)
    with pytest.raises(AudioError) as error:
        convert(tone, alias, overwrite=True)
    assert error.value.code == "OUTPUT_CLOBBER"
    alias.unlink()
    alias.symlink_to(tone)
    with pytest.raises(AudioError) as error:
        convert(tone, alias, overwrite=True)
    assert error.value.code == "OUTPUT_INVALID"
    out = tmp_path / "out.wav"
    out.write_bytes(b"preserve")
    with pytest.raises(AudioError) as error:
        convert(tone, out)
    assert error.value.code == "OUTPUT_EXISTS" and out.read_bytes() == b"preserve"
    convert(tone, out, overwrite=True)
    assert tone.read_bytes() == original


def test_source_change_and_destination_race(tone, tmp_path):
    def changed(event):
        if event["phase"] == "verify":
            os.utime(tone, ns=(time.time_ns(), time.time_ns()))

    with pytest.raises(AudioError) as error:
        convert(tone, tmp_path / "out.wav", on_progress=changed)
    assert error.value.code == "INPUT_CHANGED"

    def collision(event):
        if event["phase"] == "verify":
            (tmp_path / "out.wav").write_bytes(b"other writer")

    with pytest.raises(AudioError) as error:
        convert(tone, tmp_path / "out.wav", on_progress=collision)
    assert error.value.code == "OUTPUT_EXISTS"
    assert (tmp_path / "out.wav").read_bytes() == b"other writer"


def test_model_missing_or_tampered(tone, tmp_path):
    empty = tmp_path / "model"
    empty.mkdir()
    with pytest.raises(AudioError) as error:
        denoise(tone, tmp_path / "out.wav", model_dir=empty)
    assert error.value.code in ("MODEL_MISSING", "MODEL_INVALID")
    assert not (tmp_path / "out.wav").exists()


def test_async_cancellation_fences_worker(tone, tmp_path):
    async def exercise():
        task = asyncio.create_task(process_audio_async(tone, tmp_path / "out.wav"))
        await asyncio.sleep(0.15)
        task.cancel()
        await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(exercise())
    assert not (tmp_path / "out.wav").exists()


def test_processing_doctor_executes_engine():
    assert processing_doctor()["speech_engine"] == "ready"


@pytest.mark.parametrize(
    "settings",
    [
        {"strength": 2},
        {"target_lufs": float("nan")},
        {"native_threads": True},
        {"bit_depth": 32},
        {"channels": 0},
        {"typo": 1},
        {"format": "aac"},
        {"normalize": "yes"},
    ],
)
def test_config_rejects_invalid_or_unknown(settings):
    with pytest.raises(AudioError) as error:
        denoise("unused", "unused.wav", **settings)
    assert error.value.code == "CONFIG_INVALID"
