"""Accuracy regression tests: benchmark audio vs reference transcripts.

Runs against a live server (default http://localhost:30800, override ASR_URL).
Skipped automatically if the server or test data is missing.
  pytest -m accuracy                 # run only these
  ASR_CLIPS=775 pytest -m accuracy   # full FLEURS ru test set
"""
import concurrent.futures as cf
import csv
import os
from pathlib import Path

import httpx
import pytest

from asr.wer import wer

URL = os.environ.get("ASR_URL", "http://localhost:30800")
CLIPS = int(os.environ.get("ASR_CLIPS", "100"))
RU = Path(__file__).parent.parent / "testdata" / "ru"
pytestmark = pytest.mark.accuracy


@pytest.fixture(scope="module")
def server():
    try:
        httpx.get(f"{URL}/healthz", timeout=3).raise_for_status()
    except httpx.HTTPError:
        pytest.skip(f"ASR server not reachable at {URL}")
    return URL


def transcribe(path: Path, language: str | None) -> str:
    params = {"language": language} if language else {}
    r = httpx.post(f"{URL}/v1/listen", params=params, content=path.read_bytes(),
                   headers={"Content-Type": "audio/wav"}, timeout=120)
    r.raise_for_status()
    return r.json()["results"]["channels"][0]["alternatives"][0]["transcript"]


def fleurs_ru(n: int) -> list[tuple[Path, str]]:
    tsv = RU / "test.tsv"
    if not tsv.exists():
        pytest.skip("FLEURS ru test data not downloaded")
    rows = list(csv.reader(tsv.open(), delimiter="\t"))[:n]
    return [(RU / "test" / row[1], row[2]) for row in rows]


@pytest.mark.parametrize("language,max_wer", [("ru", 0.08), ("auto", 0.10)])
def test_russian_fleurs_wer(server, language, max_wer):
    clips = fleurs_ru(CLIPS)
    with cf.ThreadPoolExecutor(4) as ex:
        hyps = list(ex.map(lambda c: transcribe(c[0], language), clips))
    score = wer([(ref, hyp) for (_, ref), hyp in zip(clips, hyps)])
    print(f"\nFLEURS ru, {len(clips)} clips, language={language}: WER={score:.2%}")
    assert score <= max_wer


def test_single_clip(server):
    """One known clean clip should come back nearly word-for-word."""
    path, ref = fleurs_ru(1)[0]
    assert wer([(ref, transcribe(path, "ru"))]) <= 0.10
