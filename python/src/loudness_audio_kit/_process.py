"""Bounded pipes, process-tree ownership and physical stop fences."""

import errno
import os
import queue
import signal
import subprocess
import threading
import time
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

import psutil

from .errors import AudioError
from .options import Context, Options


def stop_tree(proc: subprocess.Popen[bytes]) -> None:
    descendants: list[psutil.Process] = []
    try:
        descendants = psutil.Process(proc.pid).children(recursive=True)
    except psutil.Error:
        pass
    if os.name == "posix":
        # This runner starts a new session; every child belongs to this operation.
        for attempt in range(10):
            try:
                os.killpg(proc.pid, signal.SIGKILL)
                break
            except ProcessLookupError:
                if proc.poll() is None:
                    proc.kill()
                break
            except PermissionError:
                if attempt == 9:
                    if proc.poll() is None:
                        proc.kill()
                else:
                    time.sleep(0.01)
    else:
        # psutil validates birth time before signalling retained children.
        for child in reversed(descendants):
            try:
                child.kill()
            except psutil.NoSuchProcess:
                pass
        if proc.poll() is None:
            proc.kill()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired as exc:
        raise AudioError("TERMINATION_FAILED", "Could not stop the owned audio processor.") from exc
    _, alive = psutil.wait_procs(descendants, timeout=2)
    for child in alive:
        try:
            if child.status() != psutil.STATUS_ZOMBIE:
                child.kill()
        except psutil.NoSuchProcess:
            pass
    _, alive = psutil.wait_procs(alive, timeout=2)
    for child in alive:
        try:
            if child.status() != psutil.STATUS_ZOMBIE:
                raise AudioError(
                    "TERMINATION_FAILED", "An owned audio subprocess is still running."
                )
        except psutil.NoSuchProcess:
            pass


def run(
    executable: str,
    args: Sequence[str],
    options: Options,
    context: Context,
    *,
    on_chunk: Callable[[bytes], None] | None = None,
    on_stdout_line: Callable[[str], None] | None = None,
    on_stderr_line: Callable[[str], None] | None = None,
    max_stdout_bytes: int = 2_097_152,
    temp_paths: Sequence[Path] = (),
) -> dict[str, Any]:
    context.check()
    started = time.monotonic()
    env = {
        **os.environ,
        "LC_ALL": "C",
        "OMP_NUM_THREADS": str(options.native_threads),
        "OPENBLAS_NUM_THREADS": str(options.native_threads),
        "MKL_NUM_THREADS": str(options.native_threads),
    }
    try:
        proc = subprocess.Popen(
            [executable, *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
            env=env,
            start_new_session=os.name == "posix",
        )
    except OSError as exc:
        raise AudioError(
            "DEPENDENCY_MISSING", "Could not start a required local audio executable."
        ) from exc
    events: queue.Queue[tuple[str, bytes | None]] = queue.Queue(maxsize=8)
    stopping = threading.Event()

    def put(item: tuple[str, bytes | None]) -> None:
        while not stopping.is_set():
            try:
                events.put(item, timeout=0.05)
                return
            except queue.Full:
                continue

    def pump(which: str, stream: Any) -> None:
        try:
            while not stopping.is_set():
                data = stream.read1(65536)
                if not data:
                    break
                put((which, data))
        finally:
            put((which, None))

    readers = [
        threading.Thread(target=pump, args=(which, stream), daemon=True)
        for which, stream in (("stdout", proc.stdout), ("stderr", proc.stderr))
    ]
    for reader in readers:
        reader.start()
    output = bytearray()
    stderr = bytearray()
    pending = {"stdout": bytearray(), "stderr": bytearray()}
    callbacks = {"stdout": on_stdout_line, "stderr": on_stderr_line}
    eof: set[str] = set()
    peak = 0
    rss_available = False
    last_sample = 0.0
    try:
        while len(eof) != 2 or proc.poll() is None:
            context.check()
            now = time.monotonic()
            if now - last_sample >= 0.1:
                last_sample = now
                try:
                    owner = psutil.Process(proc.pid)
                    rss = owner.memory_info().rss
                    for child in owner.children(recursive=True):
                        try:
                            rss += child.memory_info().rss
                        except psutil.NoSuchProcess:
                            pass
                    peak = max(peak, rss)
                    rss_available = True
                    if rss > options.memory_budget_mib * 1048576:
                        raise AudioError(
                            "MEMORY_LIMIT",
                            "The audio processor exceeded its sampled memory budget.",
                        )
                except psutil.NoSuchProcess:
                    pass
                except psutil.AccessDenied as exc:
                    raise AudioError(
                        "RESOURCE_MONITOR_FAILED", "Could not monitor the owned audio process."
                    ) from exc
                size = 0
                for path in temp_paths:
                    try:
                        size += path.stat().st_size
                    except FileNotFoundError:
                        pass
                if size > options.max_temp_bytes:
                    raise AudioError(
                        "TEMP_LIMIT", "Temporary audio exceeds the configured disk budget."
                    )
            try:
                which, data = events.get(timeout=0.03)
            except queue.Empty:
                continue
            if data is None:
                eof.add(which)
                callback = callbacks[which]
                if pending[which] and callback:
                    callback(pending[which].decode("utf-8", "replace"))
                pending[which].clear()
                continue
            if which == "stdout":
                if on_chunk:
                    on_chunk(data)
                elif not on_stdout_line:
                    if len(output) + len(data) > max_stdout_bytes:
                        raise AudioError(
                            "PROCESS_OUTPUT_LIMIT", "The local executable returned too much data."
                        )
                    output.extend(data)
            else:
                stderr.extend(data)
                if len(stderr) > 262144:
                    del stderr[:-262144]
            callback = callbacks[which]
            if callback:
                pending[which].extend(data)
                while b"\n" in pending[which]:
                    line, _, rest = pending[which].partition(b"\n")
                    pending[which] = bytearray(rest)
                    callback(line.decode("utf-8", "replace"))
                if len(pending[which]) > 262144:
                    raise AudioError(
                        "PROCESS_OUTPUT_LIMIT", "The local executable returned an oversized line."
                    )
        code = proc.wait()
        context.check()
        if code:
            if b"No space left" in stderr:
                raise AudioError("OUTPUT_SPACE", "There is insufficient disk space for processing.")
            raise AudioError("PROCESS_FAILED", "The local audio executable failed.")
        return {
            "stdout": bytes(output),
            "stderr": stderr.decode("utf-8", "replace"),
            "metrics": {
                "wall_ms": (time.monotonic() - started) * 1000,
                "sampled_peak_tree_rss_bytes": peak if rss_available else None,
                "sampling_interval_ms": 100,
                "memory_method": "psutil sampled owned process tree; excludes calling Python process",
            },
        }
    finally:
        stopping.set()
        try:
            stop_tree(proc)
        finally:
            # kill precedes join/close; pipe readers cannot retain a cancelled job.
            for reader in readers:
                reader.join(timeout=2)
            if proc.stdout:
                proc.stdout.close()
            if proc.stderr:
                proc.stderr.close()


def translate_os_error(exc: OSError) -> AudioError:
    if exc.errno in (errno.ENOSPC, errno.EDQUOT):
        return AudioError("OUTPUT_SPACE", "There is insufficient disk space for processing.")
    return AudioError("IO_FAILED", "Could not complete the local audio file operation.")
