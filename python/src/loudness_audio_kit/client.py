"""Shared bounded scheduling for local processing and audit jobs."""

import os
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from typing import Any

import psutil

from .analysis import analyze
from .errors import AudioError, CancellationToken
from .inspection import inspect, local_path
from .options import Context, Json, Options, bounded, options_for
from .processing import process_audio


class AudioFuture(Future[Json]):
    """cancel() requests physical cleanup; result() then raises AudioError(CANCELLED)."""

    def __init__(self, token: CancellationToken):
        super().__init__()
        self.token = token
        self._start_lock = threading.RLock()

    def cancel(self) -> bool:
        with self._start_lock:
            if self.done():
                return False
            self.token.cancel()
            if not self.running():
                self.set_exception(AudioError("CANCELLED", "The queued operation was cancelled."))
            return True

    def begin(self) -> bool:
        with self._start_lock:
            if self.done():
                return False
            return self.set_running_or_notify_cancel()

    def fail_queued(self, error: AudioError) -> None:
        with self._start_lock:
            if not self.done() and not self.running():
                self.set_exception(error)


class AudioClient:
    def __init__(
        self,
        options: Options | None = None,
        *,
        concurrency: int | None = None,
        total_memory_budget_mib: int | None = None,
        cpu_thread_budget: int | None = None,
        max_queued: int = 10000,
        **kwargs: Any,
    ):
        self.options = options_for(options, **kwargs)
        total = (
            total_memory_budget_mib
            if total_memory_budget_mib is not None
            else max(
                self.options.memory_budget_mib, int(psutil.virtual_memory().available / 1048576 / 2)
            )
        )
        bounded(total, "total_memory_budget_mib", 32, 1_048_576, True)
        threads = cpu_thread_budget if cpu_thread_budget is not None else os.cpu_count() or 1
        bounded(threads, "cpu_thread_budget", 1, 65536, True)
        slots = (
            concurrency
            if concurrency is not None
            else max(
                1,
                min(
                    8,
                    threads // self.options.native_threads,
                    total // self.options.memory_budget_mib,
                ),
            )
        )
        bounded(slots, "concurrency", 1, 256, True)
        bounded(max_queued, "max_queued", 1, 100000, True)
        if (
            slots * self.options.memory_budget_mib > total
            or slots * self.options.native_threads > threads
        ):
            raise AudioError(
                "CONFIG_INVALID",
                "Concurrency exceeds this client's memory or native-thread reservation.",
            )
        self.concurrency = slots
        self.total_memory_budget_mib = total
        self.cpu_thread_budget = threads
        self.max_queued = max_queued
        self._executor = ThreadPoolExecutor(max_workers=slots, thread_name_prefix="loudness-audio")
        self._lock = threading.RLock()
        self._closed = False
        self._futures: set[AudioFuture] = set()
        self._contexts: dict[AudioFuture, Context] = {}
        self._local = threading.local()
        self._watch_stop = threading.Event()
        self._watcher = threading.Thread(
            target=self._watch_queue, daemon=True, name="loudness-queue-deadlines"
        )
        self._watcher.start()

    def _watch_queue(self) -> None:
        while not self._watch_stop.wait(0.05):
            with self._lock:
                waiting = tuple(self._contexts.items())
            for future, context in waiting:
                if not future.running() and not future.done():
                    try:
                        context.check()
                    except AudioError as exc:
                        future.fail_queued(exc)

    def _submit(
        self,
        action: str,
        file: str | os.PathLike[str],
        output: str | os.PathLike[str] | None,
        options: Options | None,
        kwargs: Json,
    ) -> AudioFuture:
        if options is None:
            opt = options_for(self.options, **kwargs)
        else:
            # A full Options object deliberately replaces defaults; kwargs only override named fields.
            opt = options_for(options, **kwargs)
        if (
            opt.memory_budget_mib > self.options.memory_budget_mib
            or opt.native_threads > self.options.native_threads
        ):
            raise AudioError(
                "CONFIG_INVALID", "Per-job limits exceed this client's admission reservation."
            )
        parents = tuple(t for t in (self.options.cancel_token, opt.cancel_token) if t is not None)
        token = CancellationToken(parents)
        context = Context(
            replace(opt, cancel_token=token), deadline=time.monotonic() + opt.timeout_seconds
        )
        future = AudioFuture(token)

        def execute() -> None:
            try:
                if not future.begin():
                    return
                self._local.inside = True
                context.check()
                if action == "analyze":
                    value = analyze(file, opt, _context=context)
                elif action == "inspect":
                    value = inspect(file, opt, _context=context)
                else:
                    assert output is not None
                    value = process_audio(file, output, action, opt, _context=context)
                future.set_result(value)
            except BaseException as exc:
                future.set_exception(exc)
            finally:
                self._local.inside = False
                with self._lock:
                    self._futures.discard(future)
                    self._contexts.pop(future, None)

        with self._lock:
            if self._closed:
                raise AudioError("CLIENT_CLOSED", "The audio client is closed.")
            if len(self._futures) >= self.max_queued + self.concurrency:
                raise AudioError("QUEUE_FULL", "The client queue is full.")
            self._futures.add(future)
            self._contexts[future] = context
            self._executor.submit(execute)
        return future

    def submit(
        self,
        file: str | os.PathLike[str],
        output: str | os.PathLike[str],
        mode: str = "enhance",
        options: Options | None = None,
        **kwargs: Any,
    ) -> AudioFuture:
        return self._submit(mode, file, output, options, kwargs)

    def process(
        self,
        file: str | os.PathLike[str],
        output: str | os.PathLike[str],
        mode: str = "enhance",
        options: Options | None = None,
        **kwargs: Any,
    ) -> Json:
        return self.submit(file, output, mode, options, **kwargs).result()

    def denoise(
        self, file: str | os.PathLike[str], output: str | os.PathLike[str], **kwargs: Any
    ) -> Json:
        return self.process(file, output, "denoise", **kwargs)

    def enhance(
        self, file: str | os.PathLike[str], output: str | os.PathLike[str], **kwargs: Any
    ) -> Json:
        return self.process(file, output, "enhance", **kwargs)

    def normalize(
        self, file: str | os.PathLike[str], output: str | os.PathLike[str], **kwargs: Any
    ) -> Json:
        return self.process(file, output, "normalize", **kwargs)

    def convert(
        self, file: str | os.PathLike[str], output: str | os.PathLike[str], **kwargs: Any
    ) -> Json:
        return self.process(file, output, "convert", **kwargs)

    def analyze(
        self, file: str | os.PathLike[str], options: Options | None = None, **kwargs: Any
    ) -> Json:
        return self._submit("analyze", file, None, options, kwargs).result()

    def inspect(
        self, file: str | os.PathLike[str], options: Options | None = None, **kwargs: Any
    ) -> Json:
        return self._submit("inspect", file, None, options, kwargs).result()

    def close(self) -> None:
        if getattr(self._local, "inside", False):
            raise AudioError(
                "CLIENT_CLOSE_REENTRANT", "Close the client outside its progress callback."
            )
        with self._lock:
            self._closed = True
            futures = tuple(self._futures)
        for future in futures:
            future.cancel()
        self._watch_stop.set()
        self._watcher.join()
        self._executor.shutdown(wait=True)

    def __enter__(self) -> "AudioClient":
        return self

    def __exit__(self, *_args: Any) -> None:
        self.close()


def process_batch(
    jobs: list[Json],
    options: Options | None = None,
    *,
    concurrency: int | None = None,
    total_memory_budget_mib: int | None = None,
    cpu_thread_budget: int | None = None,
    max_queued: int = 10000,
    fail_fast: bool = False,
    **kwargs: Any,
) -> Json:
    opt = options_for(options, **kwargs)
    context = Context(opt)
    context.check()
    bounded(max_queued, "max_queued", 1, 100000, True)
    if (
        not isinstance(fail_fast, bool)
        or not isinstance(jobs, list)
        or not jobs
        or len(jobs) > max_queued
    ):
        raise AudioError(
            "CONFIG_INVALID", "Provide a nonempty batch within max_queued and a boolean fail_fast."
        )
    sources: set[Path] = set()
    source_ids: set[tuple[int, int]] = set()
    outputs: set[Path] = set()
    prepared = []
    try:
        for job in jobs:
            context.check()
            if not isinstance(job, dict) or set(job) - {"input", "output", "mode", "options"}:
                raise AudioError("CONFIG_INVALID", "Invalid processing job fields.")
            source = local_path(job["input"], "INPUT_INVALID").resolve(strict=True)
            out = local_path(job["output"], "OUTPUT_INVALID")
            out = out.parent.resolve(strict=True) / out.name
            if out in outputs:
                raise AudioError(
                    "OUTPUT_COLLISION", "Two batch jobs have the same output destination."
                )
            if job.get("mode", "enhance") not in ("denoise", "enhance", "normalize", "convert"):
                raise AudioError("CONFIG_INVALID", "Invalid processing mode.")
            job_opt = options_for(opt, **job.get("options", {}))
            sources.add(source)
            s = source.stat()
            source_ids.add((s.st_dev, s.st_ino))
            outputs.add(out)
            prepared.append((job, job_opt))
        for out in outputs:
            context.check()
            if out in sources:
                raise AudioError("OUTPUT_CLOBBER", "A batch output cannot replace any batch input.")
            if out.exists() and (out.stat().st_dev, out.stat().st_ino) in source_ids:
                raise AudioError("OUTPUT_CLOBBER", "A batch output aliases a batch input.")
    except (OSError, KeyError, TypeError) as exc:
        raise AudioError(
            "CONFIG_INVALID", "Every job needs readable input and a local output directory."
        ) from exc
    shared = CancellationToken((opt.cancel_token,) if opt.cancel_token else ())
    deadline = context.deadline
    with AudioClient(
        replace(opt, cancel_token=shared),
        concurrency=concurrency,
        total_memory_budget_mib=total_memory_budget_mib,
        cpu_thread_budget=cpu_thread_budget,
        max_queued=max_queued,
    ) as client:
        futures = []
        for job, job_opt in prepared:
            token = CancellationToken(
                (shared, *((job_opt.cancel_token,) if job_opt.cancel_token else ()))
            )
            remaining = max(0.001, min(job_opt.timeout_seconds, deadline - time.monotonic()))
            future = client.submit(
                job["input"],
                job["output"],
                job.get("mode", "enhance"),
                replace(job_opt, cancel_token=token, timeout_seconds=remaining),
            )
            if fail_fast:

                def stop_on_error(f: Future[Json]) -> None:
                    if f.exception() is not None:
                        shared.cancel()

                future.add_done_callback(stop_on_error)
            futures.append(future)
        results = []
        for index, future in enumerate(futures):
            try:
                result = future.result()
                results.append(
                    {
                        "index": index,
                        "file": Path(jobs[index]["input"]).name,
                        "state": "completed",
                        "result": result,
                    }
                )
            except AudioError as exc:
                results.append(
                    {
                        "index": index,
                        "file": Path(jobs[index]["input"]).name,
                        "state": "cancelled" if exc.code == "CANCELLED" else "failed",
                        "error": exc.to_dict(),
                    }
                )
    return {
        "schema_version": 1,
        "kind": "processing-batch",
        "concurrency": client.concurrency,
        "results": results,
    }


def batch(
    files: list[str],
    options: Options | None = None,
    *,
    concurrency: int | None = None,
    **kwargs: Any,
) -> Json:
    if not isinstance(files, list) or not files or len(files) > 10000:
        raise AudioError("CONFIG_INVALID", "Provide 1-10000 audio files.")
    with AudioClient(options, concurrency=concurrency, **kwargs) as client:
        futures = [client._submit("analyze", file, None, None, {}) for file in files]
        results = []
        for file, future in zip(files, futures, strict=True):
            try:
                results.append(
                    {"file": Path(file).name, "state": "completed", "analysis": future.result()}
                )
            except AudioError as exc:
                results.append(
                    {
                        "file": Path(file).name,
                        "state": "cancelled" if exc.code == "CANCELLED" else "failed",
                        "error": exc.to_dict(),
                    }
                )
    return {
        "schema_version": 1,
        "kind": "batch",
        "concurrency": client.concurrency,
        "results": results,
    }
