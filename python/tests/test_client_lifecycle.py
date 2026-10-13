import errno
import os
import sys
import threading
import time

import psutil
import pytest

import loudness_audio_kit.client as scheduling
from loudness_audio_kit import AudioClient, AudioError, CancellationToken, Options, process_batch
from loudness_audio_kit._process import run
from loudness_audio_kit.options import Context


def held_job(entered, release):
    def execute(_file, _out, _mode, _opt, *, _context):
        entered.set()
        while not release.wait(0.01):
            _context.check()
        _context.check()
        return {"ok": True}

    return execute


def test_queue_cancellation_timeout_and_admission(monkeypatch):
    entered, release = threading.Event(), threading.Event()
    monkeypatch.setattr(scheduling, "process_audio", held_job(entered, release))
    with AudioClient(concurrency=1, max_queued=1) as client:
        active = client.submit("input", "output")
        assert entered.wait(2)
        waiting = client.submit("input", "other-output", timeout_seconds=0.1)
        with pytest.raises(AudioError) as error:
            waiting.result(timeout=1)
        assert error.value.code == "TIMEOUT"
        # A finished queued future still occupies its executor queue entry until drained.
        with pytest.raises(AudioError) as error:
            client.submit("input", "more")
        assert error.value.code == "QUEUE_FULL"
        active.cancel()
        with pytest.raises(AudioError) as error:
            active.result(timeout=2)
        assert error.value.code == "CANCELLED"


def test_queued_cancel_is_immediate(monkeypatch):
    entered, release = threading.Event(), threading.Event()
    monkeypatch.setattr(scheduling, "process_audio", held_job(entered, release))
    client = AudioClient(concurrency=1)
    active = client.submit("input", "output")
    assert entered.wait(2)
    waiting = client.submit("input", "other-output")
    assert waiting.cancel()
    with pytest.raises(AudioError) as error:
        waiting.result(timeout=0.2)
    assert error.value.code == "CANCELLED"
    client.close()
    assert active.done()
    with pytest.raises(AudioError) as error:
        client.submit("in", "out")
    assert error.value.code == "CLIENT_CLOSED"


def test_parent_cancellation_reaches_queue(monkeypatch):
    entered, release = threading.Event(), threading.Event()
    monkeypatch.setattr(scheduling, "process_audio", held_job(entered, release))
    token = CancellationToken()
    with AudioClient(concurrency=1, cancel_token=token) as client:
        futures = [client.submit("in", str(i)) for i in range(4)]
        assert entered.wait(2)
        token.cancel()
        for future in futures:
            with pytest.raises(AudioError) as error:
                future.result(timeout=1)
            assert error.value.code == "CANCELLED"


def test_four_actual_workers_and_independent_results(tone, tmp_path):
    jobs = [
        {"input": str(tone), "output": str(tmp_path / f"out-{i}.wav"), "mode": "denoise"}
        for i in range(4)
    ]
    result = process_batch(jobs, concurrency=4, total_memory_budget_mib=2048, cpu_thread_budget=4)
    assert result["concurrency"] == 4
    assert [r["index"] for r in result["results"]] == list(range(4))
    assert all(r["state"] == "completed" for r in result["results"])
    assert len({r["result"]["analysis"]["decoded_pcm_sha256"] for r in result["results"]}) == 1


def test_batch_individual_token_and_fail_fast(tone, tmp_path):
    token = CancellationToken()
    token.cancel()
    jobs = [
        {
            "input": str(tone),
            "output": str(tmp_path / "cancelled.wav"),
            "options": {"cancel_token": token},
        },
        {"input": str(tone), "output": str(tmp_path / "completed.wav"), "mode": "convert"},
    ]
    result = process_batch(jobs, concurrency=2)
    assert [r["state"] for r in result["results"]] == ["cancelled", "completed"]
    (tmp_path / "completed.wav").unlink()
    result = process_batch(jobs, concurrency=1, fail_fast=True)
    assert all(r["state"] == "cancelled" for r in result["results"])


def test_batch_alias_and_destination_collisions(tone, tmp_path):
    jobs = [{"input": str(tone), "output": str(tmp_path / "out.wav")}] * 2
    with pytest.raises(AudioError) as error:
        process_batch(jobs)
    assert error.value.code == "OUTPUT_COLLISION"
    alias = tmp_path / "alias.wav"
    os.link(tone, alias)
    with pytest.raises(AudioError) as error:
        process_batch([{"input": str(tone), "output": str(alias), "options": {"overwrite": True}}])
    assert error.value.code == "OUTPUT_CLOBBER"


def test_batch_deadline_includes_preflight(monkeypatch, tone, tmp_path):
    original = scheduling.local_path

    def delayed(*args):
        time.sleep(0.04)
        return original(*args)

    monkeypatch.setattr(scheduling, "local_path", delayed)
    with pytest.raises(AudioError) as error:
        process_batch(
            [{"input": str(tone), "output": str(tmp_path / "out.wav")}], timeout_seconds=0.02
        )
    assert error.value.code == "TIMEOUT"
    assert not (tmp_path / "out.wav").exists()


def test_batch_cancelled_before_file_access():
    token = CancellationToken()
    token.cancel()
    with pytest.raises(AudioError) as error:
        process_batch([{"input": "missing", "output": "out.wav"}], cancel_token=token)
    assert error.value.code == "CANCELLED"


@pytest.mark.parametrize(
    "kwargs",
    [
        {"concurrency": 0},
        {"concurrency": 257},
        {"concurrency": 4, "total_memory_budget_mib": 512},
        {"concurrency": 2, "cpu_thread_budget": 1},
        {"max_queued": 0},
    ],
)
def test_admission_rejects_invalid_reservations(kwargs):
    with pytest.raises(AudioError) as error:
        AudioClient(**kwargs)
    assert error.value.code == "CONFIG_INVALID"


def test_close_actual_worker_cleans_private_files(tone, tmp_path):
    entered = threading.Event()

    def progress(event):
        if event["phase"] == "initialize":
            entered.set()

    client = AudioClient(concurrency=1, temp_directory=tmp_path, on_progress=progress)
    future = client.submit(tone, tmp_path / "out.wav")
    assert entered.wait(5)
    client.close()
    with pytest.raises(AudioError) as error:
        future.result()
    assert error.value.code == "CANCELLED"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["source.wav"]


def test_reentrant_close_returns_error_instead_of_deadlock(tone, tmp_path):
    with AudioClient(concurrency=1) as client:

        def progress(_event):
            client.close()

        with pytest.raises(AudioError) as error:
            client.convert(tone, tmp_path / "out.wav", on_progress=progress)
        assert error.value.code == "OBSERVER_ERROR"


def test_process_tree_fenced_on_cancel(tmp_path):
    token = CancellationToken()
    opt = Options(cancel_token=token)
    pids = []
    code = "import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(120)']); print(p.pid,flush=True); time.sleep(120)"

    def received(line):
        pids.append(int(line))
        token.cancel()

    with pytest.raises(AudioError) as error:
        run(sys.executable, ["-c", code], opt, Context(opt), on_stdout_line=received)
    assert error.value.code == "CANCELLED" and pids
    for pid in pids:
        assert not psutil.pid_exists(pid) or psutil.Process(pid).status() == psutil.STATUS_ZOMBIE


def test_stdout_cap_and_observer_kill_child():
    opt = Options()
    with pytest.raises(AudioError) as error:
        run(sys.executable, ["-c", "print('x'*10000)"], opt, Context(opt), max_stdout_bytes=100)
    assert error.value.code == "PROCESS_OUTPUT_LIMIT"


@pytest.mark.skipif(os.name != "posix", reason="POSIX process groups")
def test_startup_permission_retry(monkeypatch):
    original = os.killpg
    calls = []

    def intermittent(pid, sig):
        calls.append(pid)
        if len(calls) == 1:
            raise PermissionError(errno.EPERM, "startup")
        return original(pid, sig)

    monkeypatch.setattr(os, "killpg", intermittent)
    opt = Options(timeout_seconds=0.1)
    with pytest.raises(AudioError) as error:
        run(sys.executable, ["-c", "import time;time.sleep(120)"], opt, Context(opt))
    assert error.value.code == "TIMEOUT" and len(calls) >= 2
