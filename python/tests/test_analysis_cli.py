import hashlib
import json
import math
import signal
import subprocess
import sys

import numpy as np
import pytest
from conftest import write_wav

from loudness_audio_kit import (
    AudioError,
    Options,
    analyze,
    batch,
    benchmark,
    check_report,
    compare,
    evaluate,
    inspect,
    render_report,
    validate,
)
from loudness_audio_kit.analysis import Scanner


def test_scanner_arbitrary_pipe_boundaries_and_caps():
    audio = np.column_stack(
        [np.r_[np.zeros(100), np.ones(150), np.zeros(750)] for _ in range(2)]
    ).astype("<f8")
    opt = Options(max_points=16, max_events=0, min_silence_seconds=0.01)
    a, b = Scanner(8000, 2, opt), Scanner(8000, 2, opt)
    a.consume(audio.tobytes())
    data = audio.tobytes()
    for i in range(0, len(data), 71):
        b.consume(data[i : i + 71])
    left, right = a.finish(), b.finish()
    assert left["pcm_hash"] == right["pcm_hash"]
    assert left["channels"] == right["channels"]
    assert left["channels"][0]["longest_near_full_scale_run"] == 150
    assert left["bands"] == pytest.approx(right["bands"])
    assert b.discontinuity_count == 4 and not b.discontinuities


def test_measurements_and_silence(tone, tmp_path):
    report = analyze(tone)
    assert report["duration_seconds"] == 3
    assert report["rms_dbfs"] == pytest.approx(20 * math.log10(0.12 / math.sqrt(2)), abs=0.01)
    assert report["integrated_lufs"] is not None and report["true_peak_dbtp"] is not None
    assert report["channels"][0]["near_full_scale_samples"] == 0
    silence = write_wav(tmp_path / "silent.wav", np.zeros(8000), 8000)
    r = analyze(silence)
    assert r["state"] == "silent" and r["integrated_lufs"] is None
    assert r["silence"]["total_seconds"] == 1
    assert r["silence"]["leading_seconds"] == r["silence"]["trailing_seconds"] == 1


def test_stereo_measurements(tmp_path):
    t = np.arange(48000) / 48000
    x = 0.2 * np.sin(t * 2 * np.pi * 440)
    source = write_wav(tmp_path / "stereo.wav", np.column_stack([x, -x * 0.5]))
    r = analyze(source)
    assert r["stereo_correlation"] == pytest.approx(-1, abs=1e-6)
    assert r["channel_imbalance_db"] == pytest.approx(6.0206, abs=0.01)


def test_policy_bounds_missing_measurement_and_formats(tone, tmp_path):
    r = analyze(tone)
    result = evaluate(
        r,
        {
            "schema_version": 1,
            "name": "duration",
            "rules": [{"metric": "duration_seconds", "min": 2, "max": 4}],
            "codecs": ["pcm_s16le"],
        },
    )
    assert result["passed"] and not result["failed"]
    silent = write_wav(tmp_path / "silent.wav", np.zeros(48000))
    result = validate(
        silent,
        {
            "schema_version": 1,
            "name": "loudness",
            "unavailable": "fail",
            "rules": [{"metric": "integrated_lufs", "min": -20}],
        },
    )
    assert result["failed"] and result["results"][0]["status"] == "unavailable"


@pytest.mark.parametrize(
    "policy",
    [
        {},
        {"schema_version": 1, "name": "x", "rules": [{"metric": "unknown", "max": 1}]},
        {"schema_version": 1, "name": "x", "rules": [{"metric": "rms_dbfs", "min": 0, "max": -1}]},
        {"schema_version": 1, "name": "x", "rules": [], "typo": True},
    ],
)
def test_invalid_policy_rejected(policy, tone):
    with pytest.raises(AudioError) as error:
        validate(tone, policy)
    assert error.value.code == "POLICY_INVALID"


def test_comparison_identity_and_gain(tmp_path):
    rng = np.random.default_rng(5)
    audio = rng.normal(0, 0.1, 192000)
    a = write_wav(tmp_path / "a.wav", audio)
    b = write_wav(tmp_path / "b.wav", audio * 0.5)
    identical = compare(a, a)
    assert identical["decoded_pcm_equal"] and identical["duration_within_tolerance"]
    result = compare(a, b)
    assert result["differences"]["rms_db"] == pytest.approx(-6.0206, abs=0.01)
    assert all(w["confidence"] == "high" and w["offset_seconds"] == 0 for w in result["alignment"])


def test_comparison_detects_input_change_between_phases(tone, tmp_path):
    other = tmp_path / "other.wav"
    other.write_bytes(tone.read_bytes())

    def progress(event):
        if event["phase"] == "compare":
            with other.open("ab") as changed:
                changed.write(b"changed")

    with pytest.raises(AudioError) as error:
        compare(tone, other, on_progress=progress)
    assert error.value.code == "INPUT_CHANGED"


def test_report_escaping_and_no_external_requests(tone):
    r = analyze(tone)
    r["input"]["file"]["name"] = '<script>alert("x")</script>'
    rendered = render_report(r, title="<img onerror=alert(1)>")
    assert "<script>" not in rendered and "<img onerror" not in rendered
    assert "&lt;script&gt;" in rendered and "default-src 'none'" in rendered
    assert "<svg" in rendered


@pytest.mark.parametrize(
    "report",
    [
        None,
        [],
        {"schema_version": True, "kind": "analysis"},
        {"schema_version": 1, "kind": []},
        {"schema_version": 1, "kind": "analysis"},
        {"schema_version": 1, "kind": "batch", "results": [None]},
    ],
)
def test_malformed_reports_return_typed_errors(report):
    with pytest.raises(AudioError) as error:
        check_report(report)
    assert error.value.code == "REPORT_INVALID"


def test_waveform_and_policy_analysis_structure(tone):
    r = analyze(tone)
    r["waveform"][0] = "invalid"
    with pytest.raises(AudioError) as error:
        render_report(r)
    assert error.value.code == "REPORT_INVALID"
    with pytest.raises(AudioError) as error:
        evaluate({"kind": "analysis"}, {"schema_version": 1, "name": "x", "rules": []})
    assert error.value.code == "REPORT_INVALID"


def test_doctor_cancellation_during_filter_check(monkeypatch):
    import importlib

    diagnostics = importlib.import_module("loudness_audio_kit.doctor")

    def run(_exe, args, *_rest):
        if "-filters" in args:
            raise AudioError("CANCELLED", "stop")
        return {"stdout": b"fixture version\n"}

    monkeypatch.setattr(diagnostics, "run", run)
    with pytest.raises(AudioError) as error:
        diagnostics.doctor()
    assert error.value.code == "CANCELLED"


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX SIGINT test")
@pytest.mark.parametrize("stop_signal", [signal.SIGINT, signal.SIGTERM])
def test_cli_signal_waits_for_cleanup(stop_signal, tone, tmp_path):
    out = tmp_path / "out.wav"
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "loudness_audio_kit",
            "denoise",
            str(tone),
            "--output",
            str(out),
            "--temp-directory",
            str(tmp_path),
            "--progress",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert process.stderr is not None
        event = json.loads(process.stderr.readline())
        assert event["phase"] == "inspect"
        process.send_signal(stop_signal)
        stdout, stderr = process.communicate(timeout=15)
        assert process.returncode == 128 + stop_signal and not stdout
        assert json.loads(stderr.splitlines()[-1])["error"]["code"] == "CANCELLED"
        assert sorted(p.name for p in tmp_path.iterdir()) == ["source.wav"]
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate()


def test_batch_audit_order_and_invalid_media(tone, tmp_path):
    corrupt = tmp_path / "bad.wav"
    corrupt.write_bytes(b"bad audio")
    r = batch([str(tone), str(corrupt)], concurrency=2)
    assert [item["state"] for item in r["results"]] == ["completed", "failed"]
    with pytest.raises(AudioError):
        inspect("https://example.com/audio.wav")


def test_multistream_requires_selection(tone, tmp_path):
    out = tmp_path / "two.mka"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(tone),
            "-i",
            str(tone),
            "-map",
            "0:a",
            "-map",
            "1:a",
            "-c:a",
            "flac",
            str(out),
        ],
        check=True,
    )
    with pytest.raises(AudioError) as error:
        inspect(out)
    assert error.value.code == "STREAM_REQUIRED"
    assert inspect(out, stream_index=1)["selected_stream"]["index"] == 1


def test_benchmark_real_trusted_command(tone):
    manifest = {
        "schema_version": 1,
        "fixtures": [
            {
                "path": str(tone),
                "sha256": hashlib.sha256(tone.read_bytes()).hexdigest(),
                "license": "CC0-1.0",
            }
        ],
        "processors": [
            {
                "name": "copy",
                "executable": "ffmpeg",
                "version": "local fixture",
                "settings": {},
                "args": ["-v", "error", "-i", "{input}", "-c:a", "pcm_s16le", "{output}"],
            }
        ],
        "warmup": 1,
        "repetitions": 2,
    }
    r = benchmark(manifest)
    assert len(r["runs"]) == 2 and r["summaries"][0]["successes"] == 2
    manifest["fixtures"][0]["sha256"] = "0" * 64
    with pytest.raises(AudioError) as error:
        benchmark(manifest)
    assert error.value.code == "FIXTURE_CHANGED"


def test_nonfinite_benchmark_rejected_before_execution():
    with pytest.raises(AudioError) as error:
        benchmark({"schema_version": 1, "settings": {"bad": float("nan")}})
    assert error.value.code == "BENCHMARK_INVALID"


def test_cli_deep_json_is_a_typed_error(tmp_path):
    from loudness_audio_kit.cli import read_json

    path = tmp_path / "deep.json"
    path.write_text("[" * 10000 + "0" + "]" * 10000)
    with pytest.raises(AudioError) as error:
        read_json(str(path))
    assert error.value.code == "JSON_INVALID"


def test_cli_json_brackets_in_strings_are_preserved(tmp_path):
    from loudness_audio_kit.cli import read_json

    path = tmp_path / "ordinary.json"
    expected = {"name": "[" * 10000, "nested": [{}], "escape": '\\"}'}
    path.write_text(json.dumps(expected))
    assert read_json(str(path)) == expected


@pytest.mark.parametrize("command", ["denoise", "enhance", "normalize", "convert"])
def test_cli_real_output(command, tone, tmp_path):
    out = tmp_path / (command + ".wav")
    result = subprocess.run(
        [sys.executable, "-m", "loudness_audio_kit", command, str(tone), "--output", str(out)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["output"]["duration_seconds"] == 3


def test_cli_audit_report_policy_and_error(tone, tmp_path):
    result = subprocess.run(
        [sys.executable, "-m", "loudness_audio_kit", "analyze", str(tone)],
        capture_output=True,
        text=True,
        check=True,
    )
    report = tmp_path / "report.json"
    report.write_text(result.stdout)
    subprocess.run(
        [
            sys.executable,
            "-m",
            "loudness_audio_kit",
            "report",
            str(report),
            "--output",
            str(tmp_path / "report.html"),
        ],
        check=True,
        capture_output=True,
    )
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "loudness_audio_kit",
            "denoise",
            str(tone),
            "--output",
            str(tmp_path / "out.wav"),
            "--max-file-bytes",
            "1",
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 1 and json.loads(result.stderr)["error"]["code"] == "FILE_LIMIT"
