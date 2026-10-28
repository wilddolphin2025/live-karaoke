"""Translation: prompt building, ?translate= parsing, response shape (unit, no GPU),
and an end-to-end ru->en check against a live server (skipped when unavailable)."""
import asyncio
import os
from types import SimpleNamespace

import httpx
import numpy as np
import pytest

from asr import translate as tr


def test_prompt_known_source_matches_chat_template():
    # TranslateGemma chat template (type=text, add_generation_prompt) without BOS (llama.cpp adds it)
    p = tr.build_prompt(" Привет, мир. ", "en", "ru")
    assert p == ("<start_of_turn>user\nYou are a professional Russian (ru) to English (en) translator. Your goal is "
                 "to accurately convey the meaning and nuances of the original Russian text while adhering to English "
                 "grammar, vocabulary, and cultural sensitivities.\nProduce only the English translation, without any "
                 "additional explanations or commentary. Please translate the following Russian text into English:"
                 "\n\n\nПривет, мир.<end_of_turn>\n<start_of_turn>model\n")


def test_prompt_region_codes_and_unknown_source():
    p = tr.build_prompt("hi", "pt-br")
    assert "translator into Portuguese (pt-BR)" in p and p.endswith("into Portuguese:\n\n\nhi<end_of_turn>\n<start_of_turn>model\n")
    assert "Spanish (es-MX)" in tr.build_prompt("x", "ru", "es-mx")
    strict = tr.build_prompt("hola", "ru", "es", strict=True)
    assert "never copy the Spanish text unchanged" in strict and strict.count("<start_of_turn>") == 2


def test_languages_and_cleanup():
    assert len(tr.ADVERTISED) >= 50 and {"ru", "en", "es", "uk", "zh-tw", "pt-br"} <= set(tr.ADVERTISED)
    assert all(c in tr.LANGUAGES for c in tr.ADVERTISED)
    assert tr.normalize_lang("sr_Latn") == "sr-latn" and tr.normalize_lang("Ukrainian") == "uk"
    assert tr.clean_output("hola", "«Привет»") == "Привет" and tr.clean_output("a", '"A" and "B"') == '"A" and "B"'


@pytest.mark.parametrize("raw,want", [
    ("en", ["en"]), ("EN", ["en"]), ("pt-BR", ["pt-br"]), ("Brazilian Portuguese", ["pt-br"]), ("es-419x", ["es"]),
    ("en-US", ["en"]), ("zh_TW", ["zh-tw"]), ("en,de", ["en", "de"]), ("en,en", ["en"]),
])
def test_parse_targets(raw, want):
    assert tr.parse_targets(raw) == want


@pytest.mark.parametrize("raw", ["", "xx", "klingon", "en,de,fr"])
def test_parse_targets_rejects(raw):
    with pytest.raises(tr.UnsupportedLanguage):
        tr.parse_targets(raw)


# ---- response shape with fake engine/translator (no model, no lifespan)
class _FakeTranslator:
    model = "fake-gemma"

    def __init__(self, up=True):
        self.up, self.calls = up, []

    async def healthy(self):
        return self.up

    async def translate(self, text, target, source=None):
        self.calls.append((text, target, source))
        return f"[{target}] {text}"


class _FakeModes:
    def __init__(self):
        self.ensured = 0

    async def ensure_translate_mode(self):
        self.ensured += 1

    async def status(self):
        return {"mode": "translate"}


@pytest.fixture
def client(monkeypatch):
    from fastapi.testclient import TestClient
    from asr import api
    from asr.engine import Segment, Word

    segs = [Segment(start=0.0, end=1.0, text="Привет.", words=(Word("Привет.", 0.0, 1.0, 0.9),)),
            Segment(start=1.0, end=2.0, text="Как дела?", words=())]

    class Worker:
        engine = SimpleNamespace(model_name="fake-asr")
        async def submit(self, audio, language):
            return segs

    async def fake_decode(body):
        return np.zeros(32000, dtype=np.float32)

    monkeypatch.setattr(api, "decode", fake_decode)
    monkeypatch.setattr(api, "TRANSLATE_WAIT_S", 0)
    api.app.state.worker = Worker()
    api.app.state.translator = _FakeTranslator()
    api.app.state.modes = _FakeModes()
    return TestClient(api.app)


def test_no_translate_keeps_plain_deepgram_shape(client):
    r = client.post("/v1/listen?language=ru&utterances=true", content=b"x")
    assert r.status_code == 200
    alt = r.json()["results"]["channels"][0]["alternatives"][0]
    assert "translations" not in alt
    assert "translations" not in r.json()["results"]["utterances"][0]


def test_translate_shape(client):
    from asr import api
    r = client.post("/v1/listen?language=ru&utterances=true&translate=en", content=b"x")
    assert r.status_code == 200, r.text
    res = r.json()["results"]
    alt = res["channels"][0]["alternatives"][0]
    assert alt["transcript"] == "Привет. Как дела?"
    assert alt["translations"] == [{"language": "en", "translation": "[en] Привет. [en] Как дела?"}]
    assert res["utterances"][1]["translations"] == [{"language": "en", "translation": "[en] Как дела?"}]
    assert api.app.state.modes.ensured == 1
    assert ("Привет.", "en", "ru") in api.app.state.translator.calls


def test_translate_warming_returns_503_retry_after(client):
    from asr import api
    api.app.state.translator.up = False
    r = client.post("/v1/listen?language=ru&translate=en", content=b"x")
    assert r.status_code == 503
    assert int(r.headers["retry-after"]) > 0
    body = r.json()
    assert body["err_code"] == "TRANSLATOR_WARMING_UP" and set(body) == {"err_code", "err_msg", "request_id"}


def test_translate_bad_language_400(client):
    r = client.post("/v1/listen?translate=xx", content=b"x")
    assert r.status_code == 400 and "Unsupported translate language" in r.json()["err_msg"]


# ---- live end-to-end (server with translate support + translator up)
URL = os.environ.get("ASR_URL", "http://localhost:30800")
RU = os.path.join(os.path.dirname(__file__), "..", "testdata", "ru")


@pytest.mark.accuracy
def test_live_ru_to_en():
    try:
        info = httpx.get(f"{URL}/v1/info", timeout=5).json()
    except (httpx.HTTPError, ValueError):
        pytest.skip(f"ASR server not reachable at {URL}")
    if "translation" not in info:
        pytest.skip("server predates translation (redeploy with deploy/deploy.sh)")
    wav = next((os.path.join(RU, "test", f) for f in sorted(os.listdir(os.path.join(RU, "test")))
                if f.endswith(".wav")), None) if os.path.isdir(os.path.join(RU, "test")) else None
    if not wav:
        pytest.skip("no ru test audio")
    data = open(wav, "rb").read()
    for _ in range(int(os.environ.get("TRANSLATE_WARMUP_TRIES", "16"))):
        r = httpx.post(f"{URL}/v1/listen?language=ru&utterances=true&translate=en", content=data,
                       headers={"Content-Type": "audio/wav"}, timeout=300)
        if r.status_code != 503:
            break
        asyncio.run(asyncio.sleep(int(r.headers.get("retry-after", "15"))))
    if r.status_code == 503:
        pytest.skip("translator did not become ready")
    r.raise_for_status()
    t = r.json()["results"]["channels"][0]["alternatives"][0]["translations"][0]
    assert t["language"] == "en"
    assert t["translation"] and all(ord(ch) < 0x400 for ch in t["translation"])  # no Cyrillic left
