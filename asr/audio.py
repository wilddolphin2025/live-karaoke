"""Decode request bodies to 16 kHz mono float32.

soundfile handles wav/flac/ogg (and mp3 with recent libsndfile). Anything else,
including video containers (mp4, mov, mkv, webm) and m4a/AAC, goes through
ffmpeg, which extracts the first audio track (-vn) and resamples it.
"""
from __future__ import annotations

import asyncio
import io
import os
import shutil
import tempfile

import numpy as np
import soundfile as sf

from asr.engine import SAMPLE_RATE, to_mono_16k

FFMPEG_TIMEOUT_S = 120


class UndecodableAudio(Exception):
    """Neither soundfile nor ffmpeg could decode the body."""


def _read_soundfile(body: bytes) -> np.ndarray:
    audio, sr = sf.read(io.BytesIO(body), dtype="float32")
    return to_mono_16k(audio, sr)


async def ffmpeg_decode(body: bytes, timeout: float = FFMPEG_TIMEOUT_S) -> np.ndarray:
    """Decode any container ffmpeg understands. A tempfile (not stdin) lets ffmpeg
    seek, which mp4/mov need when the moov atom sits at the end."""
    if shutil.which("ffmpeg") is None:
        raise UndecodableAudio("ffmpeg not installed")
    fd, path = tempfile.mkstemp(prefix="asr-", suffix=".bin")
    try:
        with os.fdopen(fd, "wb") as f:
            await asyncio.to_thread(f.write, body)
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", path,
            "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "pipe:1",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise UndecodableAudio("ffmpeg timed out") from None
        if proc.returncode != 0 or not out:
            raise UndecodableAudio(err.decode(errors="replace")[-300:] or "no audio stream")
        return np.frombuffer(out[: len(out) // 4 * 4], dtype="<f4").astype(np.float32)
    finally:
        os.unlink(path)


async def decode(body: bytes) -> np.ndarray:
    """soundfile first (fast, in-memory), ffmpeg as the fallback."""
    try:
        return await asyncio.to_thread(_read_soundfile, body)
    except Exception:
        return await ffmpeg_decode(body)
