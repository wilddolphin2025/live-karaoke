"""Serialize GPU work behind an asyncio queue without blocking the event loop."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

import numpy as np

from asr.engine import ParakeetEngine, Segment


class QueueFull(Exception):
    """Raised when more jobs are waiting than we are willing to hold."""


@dataclass
class _Job:
    audio: np.ndarray
    future: asyncio.Future = field(default_factory=lambda: asyncio.get_running_loop().create_future())


class GpuWorker:
    """One consumer task feeds the single model, so the GPU never sees two jobs."""

    def __init__(self, engine: ParakeetEngine, max_pending: int = 8):
        self.engine = engine
        self.queue: asyncio.Queue[_Job] = asyncio.Queue(maxsize=max_pending)
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="gpu-worker")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)

    async def submit(self, audio: np.ndarray) -> list[Segment]:
        job = _Job(audio)
        try:
            self.queue.put_nowait(job)  # backpressure: fail fast, do not pile up
        except asyncio.QueueFull:
            raise QueueFull from None
        return await job.future

    async def _run(self) -> None:
        while True:
            job = await self.queue.get()
            try:
                if job.future.cancelled():  # client gave up while waiting
                    continue
                # The blocking CUDA call runs in a thread; the loop stays free.
                segments = await asyncio.to_thread(self.engine.transcribe, job.audio)
                if not job.future.cancelled():
                    job.future.set_result(segments)
            except Exception as exc:  # hand the error to the waiting request
                if not job.future.cancelled():
                    job.future.set_exception(exc)
            finally:
                self.queue.task_done()
