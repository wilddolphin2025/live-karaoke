"""Timed sentence segmentation, ?paragraphs=true and POST /v1/translate (no GPU), plus a live check."""
import os

import httpx
import pytest

from asr.engine import Segment, Word
from asr.sentences import from_text, sentences
from tests.test_translate import client, _FakeTranslator, _FakeModes  # noqa: F401  (fixture)


def W(w, s, e):
    return Word(w, s, e)


def test_split_on_punctuation_with_word_times():
    seg = Segment(0, 10, "", (W("Привет,", 0.5, 0.9), W("мир.", 1.0, 1.4), W("Как", 2.0, 2.2), W("дела?", 2.3, 2.8)))
    got = sentences([seg])
    assert [(s.text, s.start, s.end) for s in got] == [("Привет, мир.", 0.5, 1.4), ("Как дела?", 2.0, 2.8)]


def test_split_on_long_pause_and_max_words():
    words = tuple(W(f"w{i}", i * 0.3, i * 0.3 + 0.2) for i in range(45)) + (W("late", 30.0, 30.5),)
    got = sentences([Segment(0, 31, "", words)])
    assert len(got[0].text.split()) == 40 and got[-1].text == "late" and got[-1].start == 30.0


def test_text_fallback_interpolates_times():
    got = from_text("Один. Два три!  Четыре?", 10.0, 20.0)
    assert [s.text for s in got] == ["Один.", "Два три!", "Четыре?"]
    assert got[0].start == 10.0 and abs(got[-1].end - 20.0) < 1e-6
    assert all(a.end <= b.start + 1e-6 for a, b in zip(got, got[1:]))


def test_listen_paragraphs_deepgram_shape(client):
    r = client.post("/v1/listen?language=ru&paragraphs=true", content=b"x")
    alt = r.json()["results"]["channels"][0]["alternatives"][0]
    assert "translations" not in alt
    paras = alt["paragraphs"]["paragraphs"]
    assert paras[0]["sentences"] == [{"text": "Привет.", "start": 0.0, "end": 1.0}]
    assert paras[1]["sentences"][0]["text"] == "Как дела?"
    assert alt["paragraphs"]["transcript"] == alt["transcript"]


def test_listen_without_paragraphs_has_none(client):
    alt = client.post("/v1/listen", content=b"x").json()["results"]["channels"][0]["alternatives"][0]
    assert "paragraphs" not in alt


def test_translate_endpoint_echoes_timing(client):
    from asr import api
    r = client.post("/v1/translate", json={"target": "en", "source": "ru",
                                           "sentences": [{"text": "Привет.", "start": 0.5, "end": 1.4}]})
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["language"] == "en" and b["source"] == "ru" and b["model"] == "fake-riva" and b["request_id"]
    assert b["sentences"] == [{"text": "Привет.", "start": 0.5, "end": 1.4, "translation": "[en] Привет."}]
    assert api.app.state.modes.ensured == 1


def test_translate_empty_is_warmup(client):
    r = client.post("/v1/translate", json={"target": "de", "source": "auto"})
    assert r.status_code == 200 and r.json()["sentences"] == [] and r.json()["source"] is None


def test_translate_warming_503(client):
    from asr import api
    api.app.state.translator.up = False
    r = client.post("/v1/translate", json={"target": "en", "sentences": [{"text": "x"}]})
    assert r.status_code == 503 and int(r.headers["retry-after"]) > 0
    assert r.json()["err_code"] == "TRANSLATOR_WARMING_UP"


@pytest.mark.parametrize("body", [{"target": "xx"}, {"target": "en,de"}, {"target": "en", "source": "zz"}])
def test_translate_bad_language_400(client, body):
    assert client.post("/v1/translate", json=body).status_code == 400


# ---- live
URL = os.environ.get("ASR_URL", "http://localhost:30800")


@pytest.mark.accuracy
def test_live_translate_endpoint():
    import time
    try:
        info = httpx.get(f"{URL}/v1/info", timeout=5).json()
    except (httpx.HTTPError, ValueError):
        pytest.skip(f"ASR server not reachable at {URL}")
    if not info.get("app_version", "0").startswith("0.5"):
        pytest.skip("server predates /v1/translate (redeploy with deploy/deploy.sh)")
    body = {"target": "en", "source": "ru", "sentences": [{"text": "Доброе утро, друзья.", "start": 1.0, "end": 2.5}]}
    for _ in range(int(os.environ.get("TRANSLATE_WARMUP_TRIES", "16"))):
        r = httpx.post(f"{URL}/v1/translate", json=body, timeout=120)
        if r.status_code != 503:
            break
        time.sleep(int(r.headers.get("retry-after", "15")))
    if r.status_code == 503:
        pytest.skip("translator did not become ready")
    r.raise_for_status()
    s = r.json()["sentences"][0]
    assert (s["start"], s["end"]) == (1.0, 2.5)
    assert s["translation"] and all(ord(ch) < 0x400 for ch in s["translation"])
