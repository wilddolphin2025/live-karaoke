"""Decoding of video/compressed containers through the ffmpeg fallback.
Skipped when ffmpeg is not installed."""
import asyncio
import shutil
import subprocess

import numpy as np
import pytest

from asr.audio import UndecodableAudio, decode, ffmpeg_decode

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")

# (extension, extra ffmpeg args): video + audio tracks, like a phone recording.
CASES = {
    "mp4": ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"],
    "mov": ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"],
    "mkv": ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"],
    "webm": ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-c:a", "libopus"],
    "m4a": ["-vn", "-c:a", "aac"],
}


def _make(tmp_path, ext, args, seconds=1.0):
    out = tmp_path / f"t.{ext}"
    video = [] if "-vn" in args else ["-f", "lavfi", "-i", f"testsrc=size=64x64:rate=10:duration={seconds}"]
    cmd = ["ffmpeg", "-loglevel", "error", "-y", *video,
           "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=44100:duration={seconds}", *args, "-shortest", str(out)]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        pytest.skip(f"ffmpeg cannot encode {ext}: {r.stderr.decode()[-200:]}")
    return out.read_bytes()


@pytest.mark.parametrize("ext", list(CASES))
def test_decode_container(tmp_path, ext):
    audio = asyncio.run(decode(_make(tmp_path, ext, CASES[ext])))
    assert audio.dtype == np.float32 and audio.ndim == 1
    assert 0.8 * 16000 < len(audio) < 1.3 * 16000  # ~1 s at 16 kHz (codec padding allowed)
    assert np.abs(audio).max() > 0.1  # the sine is actually there


def test_garbage_is_rejected():
    with pytest.raises(UndecodableAudio):
        asyncio.run(decode(b"definitely not audio" * 100))


def test_video_without_audio_is_rejected(tmp_path):
    out = tmp_path / "silent.mp4"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=10:duration=1",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(out)], check=True)
    with pytest.raises(UndecodableAudio):
        asyncio.run(ffmpeg_decode(out.read_bytes()))
