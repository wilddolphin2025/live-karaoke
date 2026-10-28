"""Vocal removal (karaoke) with Demucs, chunked so peak VRAM/RAM stay small.

Used by the on-demand separator pod (asr/separator_api.py). Pure functions here so tests and
the benchmark (bench/separate_bench.py) can call them without a server.

Memory plan for the 4 GB RTX 3050 shared with ASR/translator:
  * outer chunks of CHUNK_S seconds (default 30 s) with OVERLAP_S crossfade, so host RAM holds
    one chunk's 4 stems at a time instead of the whole song's;
  * inside each chunk Demucs' own split=True runs `segment`-second windows (htdemucs max 7.8 s)
    with its 25 % overlap, which is what bounds VRAM;
  * the device is chosen per job: CUDA only if enough VRAM is free (mem_get_info), else CPU.
"""
from __future__ import annotations

import os
import subprocess
import time
from dataclasses import dataclass
from typing import Callable

import numpy as np

MODEL = os.environ.get("SEPARATOR_MODEL", "htdemucs_ft")
CHUNK_S = float(os.environ.get("SEPARATOR_CHUNK_S", "30"))
OVERLAP_S = float(os.environ.get("SEPARATOR_OVERLAP_S", "1"))
SEGMENT_S = float(os.environ.get("SEPARATOR_SEGMENT_S", "7.8"))
# Free VRAM (MiB) required before we use the GPU; below it we run on CPU.
MIN_FREE_VRAM_MB = int(os.environ.get("SEPARATOR_MIN_FREE_VRAM_MB", "900"))
DEVICE = os.environ.get("SEPARATOR_DEVICE", "auto")   # auto | cuda | cpu
SR = 44_100


@dataclass
class Stems:
    vocals: np.ndarray        # (2, n) float32 at SR
    instrumental: np.ndarray  # (2, n) float32 at SR (everything but vocals)
    device: str
    seconds: float


def load_stereo(path: str, sr: int = SR) -> np.ndarray:
    """Any ffmpeg-readable media (video too) -> (2, n) float32 at sr."""
    out = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", path,
                          "-vn", "-ac", "2", "-ar", str(sr), "-f", "f32le", "pipe:1"],
                         capture_output=True, check=True, timeout=600).stdout
    a = np.frombuffer(out[: len(out) // 8 * 8], dtype="<f4")
    return np.ascontiguousarray(a.reshape(-1, 2).T)


def pick_device(want: str = DEVICE, min_free_mb: int = MIN_FREE_VRAM_MB) -> str:
    import torch
    if want == "cpu" or not torch.cuda.is_available():
        return "cpu"
    if want == "cuda":
        return "cuda"
    free, _ = torch.cuda.mem_get_info()
    return "cuda" if free / 2**20 >= min_free_mb else "cpu"


def chunk_bounds(n: int, chunk: int, overlap: int) -> list[tuple[int, int]]:
    """[start, end) windows covering n samples; consecutive windows share `overlap` samples."""
    if n <= chunk:
        return [(0, n)]
    out, s = [], 0
    while True:
        e = min(s + chunk, n)
        out.append((s, e))
        if e >= n:
            return out
        s = e - overlap


def crossfade_join(parts: list[tuple[int, np.ndarray]], n: int, overlap: int) -> np.ndarray:
    """Overlap-add chunk outputs (start, (C, len)) with linear fades over the shared samples."""
    out = np.zeros((parts[0][1].shape[0], n), dtype=np.float32)
    for i, (s, x) in enumerate(parts):
        w = np.ones(x.shape[1], dtype=np.float32)
        ov = min(overlap, x.shape[1])
        if i > 0 and ov:
            w[:ov] = np.linspace(0, 1, ov, dtype=np.float32)
        if i < len(parts) - 1 and ov:
            w[-ov:] = np.minimum(w[-ov:], np.linspace(1, 0, ov, dtype=np.float32))
        out[:, s : s + x.shape[1]] += x * w
    return out


_MODELS: dict = {}


def get_model(name: str = MODEL):
    if name not in _MODELS:
        from demucs.pretrained import get_model as _get
        m = _get(name)
        m.eval()
        _MODELS[name] = m
    return _MODELS[name]


def separate(mix: np.ndarray, model_name: str = MODEL, device: str | None = None,
             progress: Callable[[float], None] | None = None,
             chunk_s: float = CHUNK_S, overlap_s: float = OVERLAP_S, segment_s: float = SEGMENT_S) -> Stems:
    """mix: (2, n) float32 at SR. Returns vocals and the sum of the other stems."""
    import torch
    from demucs.apply import apply_model
    t0 = time.time()
    model = get_model(model_name)
    device = device or pick_device()
    seg = min(segment_s, float(getattr(model, "segment", segment_s) if not hasattr(model, "models")
                         else min(float(m.segment) for m in model.models)))
    vi = model.sources.index("vocals")
    ref = mix.mean(0)
    mean, std = float(ref.mean()), float(ref.std()) or 1.0
    n = mix.shape[1]
    bounds = chunk_bounds(n, int(chunk_s * SR), int(overlap_s * SR))
    voc, inst = [], []
    for i, (s, e) in enumerate(bounds):
        x = torch.from_numpy((mix[:, s:e] - mean) / std)[None]
        with torch.inference_mode():
            y = apply_model(model, x, device=device, split=True, segment=seg, overlap=0.25,
                            shifts=0, progress=False, num_workers=0)[0]
        y = (y * std + mean).float().numpy()
        voc.append((s, y[vi]))
        inst.append((s, y.sum(0) - y[vi]))
        del x, y
        if device == "cuda":
            torch.cuda.empty_cache()
        if progress:
            progress((i + 1) / len(bounds))
    ov = int(overlap_s * SR)
    return Stems(crossfade_join(voc, n, ov), crossfade_join(inst, n, ov), device, time.time() - t0)


def write_wav(path: str, x: np.ndarray, sr: int = SR) -> None:
    import soundfile as sf
    sf.write(path, np.clip(x.T, -1, 1), sr, subtype="PCM_16")


def mux_command(src: str, instrumental_wav: str, dst: str, is_video: bool) -> list[str]:
    """ffmpeg command that writes the karaoke file. Video: copy the video stream untouched
    (-c:v copy) and replace the audio with the instrumental. Audio: encode the instrumental."""
    base = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
    if is_video:
        ext = os.path.splitext(dst)[1].lower()
        acodec = ["-c:a", "libopus", "-b:a", "160k"] if ext == ".webm" else ["-c:a", "aac", "-b:a", "192k"]
        return base + ["-i", src, "-i", instrumental_wav, "-map", "0:v:0", "-map", "1:a:0",
                       "-c:v", "copy", *acodec, dst]   # no -shortest: keep every video packet
    return base + ["-i", instrumental_wav, "-c:a", "libmp3lame", "-b:a", "192k", dst]
