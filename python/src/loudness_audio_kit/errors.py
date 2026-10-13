"""Stable exceptions and cooperative cancellation controls."""

import threading
from collections.abc import Iterable


class AudioError(Exception):
    """A stable machine-readable code plus a human-readable message."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)

    def to_dict(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


class CancellationToken:
    """Thread-safe, one-way cancellation. Each recording owns its token."""

    def __init__(self, parents: Iterable["CancellationToken"] = ()):
        self._event = threading.Event()
        self._parents = tuple(parents)

    def cancel(self) -> None:
        self._event.set()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set() or any(p.cancelled for p in self._parents)
