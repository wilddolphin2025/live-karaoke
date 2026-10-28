"""Parakeet ASR engine: load the model once, transcribe in-memory audio."""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass

import numpy as np
import torch

SAMPLE_RATE = 16_000
MODEL_NAME = os.environ.get("ASR_MODEL", "nvidia/nemotron-labs-unified-asr-0.6b")
# "cuda" in the pods; "cpu" for local checks while the GPU is busy.
DEVICE = os.environ.get("ASR_DEVICE", "cuda")
# Word timestamps feed the extension's karaoke highlighting; set 0 to disable.
WORD_TIMESTAMPS = os.environ.get("ASR_WORD_TIMESTAMPS", "1") != "0"


@dataclass(frozen=True)
class Word:
    word: str
    start: float  # seconds, absolute in the file
    end: float
    confidence: float = 1.0


@dataclass(frozen=True)
class Segment:
    start: float  # seconds
    end: float
    text: str
    words: tuple[Word, ...] = ()


def to_mono_16k(audio: np.ndarray, sr: int) -> np.ndarray:
    """Downmix to mono and resample to 16 kHz float32."""
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    audio = audio.astype(np.float32, copy=False)
    if sr != SAMPLE_RATE:
        import torchaudio.functional as F
        audio = F.resample(torch.from_numpy(audio), sr, SAMPLE_RATE).numpy()
    return audio


class ParakeetEngine:
    """Owns the model. Not thread-safe: call from one worker at a time."""

    def __init__(self, model_name: str = MODEL_NAME, chunk_seconds: int = 60,
                 device: str = DEVICE, word_timestamps: bool = WORD_TIMESTAMPS):
        # Hard cap on this process's share of the GPU (e.g. 0.45 with 2 workers).
        # PyTorch raises OutOfMemoryError at the cap instead of starving neighbours.
        frac = float(os.environ.get("GPU_MEM_FRACTION", "0"))
        if frac > 0 and device == "cuda":
            torch.cuda.set_per_process_memory_fraction(frac)
        logging.getLogger("nemo_logger").setLevel(logging.ERROR)
        import nemo.collections.asr as nemo_asr  # heavy import, deferred

        self.chunk_seconds = chunk_seconds
        self.model_name = model_name
        self.device = device
        self.word_timestamps = word_timestamps
        model = nemo_asr.models.ASRModel.from_pretrained(model_name, map_location="cpu").eval()
        # bf16 on GPU to fit 4 GB; CPU stays fp32.
        self.model = model.to(torch.bfloat16).cuda() if device == "cuda" else model

    @property
    def supports_language(self) -> bool:
        return "Prompt" in type(self.model).__name__

    @torch.inference_mode()
    def transcribe(self, audio: np.ndarray, language: str = "auto") -> list[Segment]:
        """Transcribe 16 kHz mono float32 audio, chunked to fit 4 GB VRAM.

        language: ISO code ("en", "ru", ...) or "auto". Only prompt-conditioned
        models (e.g. nemotron-labs-unified) use it; others ignore it.
        """
        step = self.chunk_seconds * SAMPLE_RATE
        chunks = [audio[i : i + step] for i in range(0, len(audio), step)]
        # NeMo accepts numpy arrays directly: no temp files needed.
        kwargs = {"target_lang": language} if self.supports_language else {}
        if self.word_timestamps:
            kwargs["timestamps"] = True
        results = self.model.transcribe(chunks, batch_size=1, verbose=False, **kwargs)
        segments = []
        for i, r in enumerate(results):
            offset = i * self.chunk_seconds
            segments.append(Segment(
                start=offset,
                end=min((i + 1) * self.chunk_seconds, len(audio) / SAMPLE_RATE),
                text=r.text,
                words=_words(r, offset),
            ))
        return segments


def _words(hyp, offset: float) -> tuple[Word, ...]:
    """NeMo hypothesis.timestamp["word"] -> Words shifted by the chunk offset.
    Entries carry start/end in seconds (plus frame offsets we ignore)."""
    ts = getattr(hyp, "timestamp", None)
    if not isinstance(ts, dict):
        return ()
    out = []
    for w in ts.get("word") or []:
        if "start" not in w or "end" not in w or not str(w.get("word", "")).strip():
            continue
        out.append(Word(word=str(w["word"]), start=round(offset + float(w["start"]), 3),
                        end=round(offset + float(w["end"]), 3)))
    return tuple(out)
