"""Sentence segmentation with timings (Deepgram `paragraphs` shape).

Words carry their own start/end, so a sentence's span is its first word's start to
its last word's end; that is what the extension uses to highlight the translated
sentence while the source is playing. Without word timings, a segment's text is
split on punctuation and times are interpolated by character count.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from asr.engine import Segment

_END = re.compile(r"[.!?…。！？]+[\"'»”)\]]*$")
_SPLIT = re.compile(r"(?<=[.!?…。！？])[\"'»”)\]]*\s+")
MAX_WORDS = 40      # force a break in run-on text (no terminal punctuation), at the last comma if any
PAUSE_S = 3.0       # ...or at a long pause, but only once the sentence is already MIN_PAUSE_WORDS long
MIN_PAUSE_WORDS = 8  # (short pauses mid-clause, e.g. "Northern Arizona, | located in Flagstaff", stay together)
_COMMA = re.compile(r"[,;:—–]$")


@dataclass(frozen=True)
class Sentence:
    text: str
    start: float
    end: float


def from_words(words) -> list[Sentence]:
    out: list[Sentence] = []
    cur: list = []

    def flush():
        if cur:
            out.append(Sentence(" ".join(w.word for w in cur), cur[0].start, cur[-1].end))
            cur.clear()

    for w in words:
        if cur and w.start - cur[-1].end > PAUSE_S and len(cur) >= MIN_PAUSE_WORDS:
            flush()
        elif len(cur) >= MAX_WORDS:
            cut = max((i for i, x in enumerate(cur[:-1]) if _COMMA.search(x.word)), default=None)
            if cut is None or cut < MAX_WORDS // 4:
                flush()
            else:  # break after the last comma, carry the rest into the next sentence
                rest = cur[cut + 1:]
                del cur[cut + 1:]
                flush()
                cur.extend(rest)
        cur.append(w)
        if _END.search(w.word):
            flush()
    flush()
    return out


def from_text(text: str, start: float, end: float) -> list[Sentence]:
    parts = [p.strip() for p in _SPLIT.split(text.strip()) if p.strip()]
    total = sum(len(p) for p in parts) or 1
    out, t = [], start
    for p in parts:
        d = (end - start) * len(p) / total
        out.append(Sentence(p, round(t, 3), round(t + d, 3)))
        t += d
    return out


def sentences(segments: list[Segment]) -> list[Sentence]:
    out: list[Sentence] = []
    for s in segments:
        out += from_words(s.words) if s.words else from_text(s.text, s.start, s.end)
    return out
