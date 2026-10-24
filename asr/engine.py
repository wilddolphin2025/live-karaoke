"""Parakeet ASR engine: load the model once, transcribe in-memory audio."""
from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np
import torch

SAMPLE_RATE = 16_000
MODEL_NAME = "nvidia/parakeet-tdt-0.6b-v3"


@dataclass(frozen=True)
class Segment:
    start: float  # seconds
    end: float
    text: str


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

    def __init__(self, model_name: str = MODEL_NAME, chunk_seconds: int = 60):
        logging.getLogger("nemo_logger").setLevel(logging.ERROR)
        import nemo.collections.asr as nemo_asr  # heavy import, deferred

        self.chunk_seconds = chunk_seconds
        self.model = (
            nemo_asr.models.ASRModel.from_pretrained(model_name, map_location="cpu")
            .eval()
            .to(torch.bfloat16)
            .cuda()
        )

    @torch.inference_mode()
    def transcribe(self, audio: np.ndarray) -> list[Segment]:
        """Transcribe 16 kHz mono float32 audio, chunked to fit 4 GB VRAM."""
        step = self.chunk_seconds * SAMPLE_RATE
        chunks = [audio[i : i + step] for i in range(0, len(audio), step)]
        # NeMo accepts numpy arrays directly: no temp files needed.
        results = self.model.transcribe(chunks, batch_size=1, verbose=False)
        return [
            Segment(
                start=i * self.chunk_seconds,
                end=min((i + 1) * self.chunk_seconds, len(audio) / SAMPLE_RATE),
                text=r.text,
            )
            for i, r in enumerate(results)
        ]
