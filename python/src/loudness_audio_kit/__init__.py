"""Loudness.ai's local Python Audio Kit."""

from .analysis import analyze
from .benchmark import benchmark
from .client import AudioClient, AudioFuture, batch, process_batch
from .comparison import compare
from .doctor import doctor, processing_doctor
from .errors import AudioError, CancellationToken
from .inspection import inspect
from .options import Options
from .policy import EXAMPLE_POLICY, evaluate, validate
from .processing import convert, denoise, enhance, normalize, process_audio, process_audio_async
from .report import check_report, render_report

__version__ = "1.0.1"
__all__ = [
    "AudioClient",
    "AudioFuture",
    "AudioError",
    "CancellationToken",
    "Options",
    "EXAMPLE_POLICY",
    "analyze",
    "inspect",
    "batch",
    "process_batch",
    "evaluate",
    "validate",
    "doctor",
    "processing_doctor",
    "convert",
    "denoise",
    "enhance",
    "normalize",
    "process_audio",
    "process_audio_async",
    "benchmark",
    "compare",
    "check_report",
    "render_report",
]
