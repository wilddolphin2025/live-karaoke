"""On-demand translation with google/translategemma-4b-it via a llama.cpp server.

Pieces:
  * language table + prompt building (mirrors the model's chat template, sent as a raw
    /completion prompt so llama.cpp needs no template support)
  * TranslatorClient: llama.cpp /completion calls, one segment at a time, echo check + retries
  * ModeController: flips the cluster between "asr" mode (2 ASR pods) and
    "translate" mode (1 ASR pod + translator) by patching Deployment scales
    through the Kubernetes API with the pod's ServiceAccount token.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import json
from pathlib import Path
import ssl
import time
from datetime import datetime, timezone

import httpx

log = logging.getLogger("translate")

# ---- TranslateGemma: the 581 codes (BCP-47-ish, e.g. pt-BR, zh-TW, sr-Latn) of its chat template,
# extracted from the GGUF's tokenizer.chat_template. We accept all of them; /v1/info lists the 55
# languages Google evaluated (WMT24++), see TRANSLATEGEMMA_MAIN.
_TG = json.loads((Path(__file__).with_name("translategemma_languages.json")).read_text(encoding="utf-8"))
TRANSLATEGEMMA_CODES: dict[str, str] = {k.lower(): k for k in _TG}      # lookup key -> template code
TRANSLATEGEMMA_LANGUAGES: dict[str, str] = {k.lower(): v for k, v in _TG.items()}
TRANSLATEGEMMA_MAIN = sorted("""ar bg bn ca cs da de el en es et fa fi fr gu he hi hr hu id is it ja kn ko lt
    lv ml mr nl no pa pl pt pt-br pt-pt ro ru sk sl sr sv sw ta te th tl tr uk ur vi zh zh-tw zu""".split())

MODEL_NAME = "google/translategemma-4b-it (Q4_K_M GGUF)"
STOP = ["<end_of_turn>", "<start_of_turn>"]
LANGUAGES: dict[str, str] = TRANSLATEGEMMA_LANGUAGES   # every accepted code -> name
ADVERTISED: list[str] = TRANSLATEGEMMA_MAIN             # what /v1/info lists
_BY_NAME: dict[str, str] = {}
for _k, _v in reversed(list(LANGUAGES.items())):
    if "-" not in _k or _v.lower() not in _BY_NAME:
        _BY_NAME[_v.lower()] = _k
_BY_NAME.update({"spanish": "es", "portuguese": "pt", "chinese": "zh",
                 "brazilian portuguese": "pt-br", "european portuguese": "pt-pt", "latin american spanish":
                 "es-mx", "traditional chinese": "zh-tw",
                 "simplified chinese": "zh"})
MAX_TARGETS = 2


class UnsupportedLanguage(ValueError):
    pass


def normalize_lang(value: str) -> str:
    """'EN', 'en_US'?, 'pt-BR', 'Brazilian Portuguese' -> a key of LANGUAGES."""
    v = value.strip().replace("_", "-").lower()
    if v in LANGUAGES:
        return v
    if v in _BY_NAME:
        return _BY_NAME[v]
    if "-" in v and v.split("-")[0] in LANGUAGES:  # e.g. en-us -> en
        return v.split("-")[0]
    raise UnsupportedLanguage(value)


def parse_targets(raw: str) -> list[str]:
    """Deepgram's ?translate= value: one code, or a comma-separated list."""
    out: list[str] = []
    for part in raw.split(","):
        if part.strip():
            code = normalize_lang(part)
            if code not in out:
                out.append(code)
    if not out:
        raise UnsupportedLanguage(raw)
    if len(out) > MAX_TARGETS:
        raise UnsupportedLanguage(f"at most {MAX_TARGETS} target languages")
    return out


def build_prompt(text: str, target: str, source: str | None = None, strict: bool = False) -> str:
    """Identical to TranslateGemma's chat template (type=text, add_generation_prompt=True), minus the
    BOS token, which llama.cpp adds when tokenizing. The template requires a source language; when
    it is unknown we keep the same wording with "the original" in place of the source name.
    strict=True (echo retry) adds one sentence to the template's own instruction block."""
    tc, tl = TRANSLATEGEMMA_CODES[target], TRANSLATEGEMMA_LANGUAGES[target]
    if source and source in TRANSLATEGEMMA_CODES:
        sc, sl = TRANSLATEGEMMA_CODES[source], TRANSLATEGEMMA_LANGUAGES[source]
        intro = f"You are a professional {sl} ({sc}) to {tl} ({tc}) translator."
        orig = f"{sl} text"
    else:
        sl, intro, orig = "", f"You are a professional translator into {tl} ({tc}).", "text"
    p = (f"<start_of_turn>user\n{intro} Your goal is to accurately convey the meaning and nuances of the "
         f"original {orig} while adhering to {tl} grammar, vocabulary, and cultural sensitivities.\n"
         f"Produce only the {tl} translation, without any additional explanations or commentary. ")
    if strict:
        p += (f"Translate every word, including repeated phrases and names in context; never copy the "
              f"{orig} unchanged. ")
    p += f"Please translate the following {orig} into {tl}:\n\n\n{text.strip()}<end_of_turn>\n<start_of_turn>model\n"
    return p


def clean_output(src: str, out: str) -> str:
    """Drop quotes the model wraps around a whole answer when the source had none."""
    o = out.strip()
    pairs = [('"', '"'), ("«", "»"), ("“", "”"), ("„", "“")]
    s = src.strip()
    for a, b in pairs:
        if len(o) > 2 and o.startswith(a) and o.endswith(b) and not s.startswith(a) and a not in o[1:-1] and b not in o[1:-1]:
            return o[1:-1].strip()
    return o


# --------------------------------------------------------------------------- source detection
# The ASR model does not report a language, and TranslateGemma's template wants a source
# (and the old Riva model echoed Spanish with a generic prompt). Guess it from the text:
# script first, then function-word counts for Latin-script languages. Cheap, and good enough to
# pick the system prompt; callers that know the language pass it explicitly.
_STOP = {
    "en": "the and of to is in that it you for was with on are this be have not but they",
    "es": "el la de que y en los se del las por un una con no es lo me para su al como más pero",
    "fr": "le la les de des et est un une du que qui dans pas pour sur au avec ce il je ne vous",
    "de": "der die das und ist nicht ich ein eine zu den mit von sich auf für dem es im auch",
    "it": "il di che e la per un una non è sono del della gli le si con mi ma come anche",
    "pt": "o a os de que e do da em um uma não para com se por mais as dos das ao foi",
    "nl": "de het een en van is niet dat ik je op te zijn met voor er die maar",
    "pl": "i w nie się na że z do to jest jak co ale o po tak jestem",
    "cs": "a je se v na že to s z do jsem jak ale o by není",
    "sv": "och att det är en som på för av med jag inte har till den",
    "ro": "și de la în nu cu că pe o un este se ce mai din",
    "tr": "ve bir bu da de için ne ile çok ama gibi daha",
}
_STOPSETS = {k: set(v.split()) for k, v in _STOP.items()}


def detect_language(text: str) -> str | None:
    """Best-effort ISO code of `text`, or None when unsure."""
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return None
    def frac(lo, hi):
        return sum(lo <= ord(c) <= hi for c in letters) / len(letters)
    if frac(0x0400, 0x04FF) > 0.5:
        t = text.lower()
        if any(c in t for c in "іїєґ"):
            return "uk"
        if any(c in t for c in "ъ") and not any(c in t for c in "ыэё"):
            return "bg"
        return "ru"
    for lo, hi, code in ((0x0370, 0x03FF, "el"), (0x0600, 0x06FF, "ar"), (0x0900, 0x097F, "hi"),
                         (0x0E00, 0x0E7F, "th"), (0x3040, 0x30FF, "ja"), (0xAC00, 0xD7AF, "ko"),
                         (0x4E00, 0x9FFF, "zh")):
        if frac(lo, hi) > 0.3:
            return code
    words = [w.strip(".,;:!?¡¿\"'«»()…-").lower() for w in text.split()]
    scores = {k: sum(w in s for w in words) for k, s in _STOPSETS.items()}
    best = max(scores, key=scores.get)
    ranked = sorted(scores.values(), reverse=True)
    if ranked[0] == 0 or (len(words) >= 4 and ranked[0] == ranked[1]):
        return None
    return best


_SCRIPT = {"ru": (0x0400, 0x04FF), "uk": (0x0400, 0x04FF), "bg": (0x0400, 0x04FF), "el": (0x0370, 0x03FF),
           "ar": (0x0600, 0x06FF), "hi": (0x0900, 0x097F), "th": (0x0E00, 0x0E7F), "ko": (0xAC00, 0xD7AF),
           "ja": (0x3040, 0x9FFF), "zh": (0x4E00, 0x9FFF), "zh-cn": (0x4E00, 0x9FFF), "zh-tw": (0x4E00, 0x9FFF)}


def looks_untranslated(src: str, out: str, target: str, source: str | None = None) -> bool:
    """The model echoed the input (or answered in the wrong script) instead of translating."""
    import difflib
    a, b = src.strip().lower(), out.strip().lower()
    if not b:
        return True
    if target in _SCRIPT:
        lo, hi = _SCRIPT[target]
        letters = [c for c in b if c.isalpha()]
        if letters and sum(lo <= ord(c) <= hi for c in letters) / len(letters) < 0.8:  # names may stay Latin; whole clauses may not
            return True
    if source and source == target:
        return False
    return len(a) > 12 and difflib.SequenceMatcher(None, a, b).ratio() > 0.8


def split_clauses(text: str, max_words: int = 14) -> list[str]:
    """Comma-separated chunks of at most ~max_words, for retrying sentences the model will not translate."""
    parts, cur = [], []
    for piece in re.split(r"(?<=[,;:])\s+", text.strip()):
        if cur and len(" ".join(cur + [piece]).split()) > max_words:
            parts.append(" ".join(cur)); cur = []
        cur.append(piece)
    if cur:
        parts.append(" ".join(cur))
    return parts


class TranslatorUnavailable(Exception):
    """Translator not ready (warming up, switching modes): retry later."""

    def __init__(self, msg: str = "Translator is warming up.", retry_after: int = 15):
        super().__init__(msg)
        self.retry_after = retry_after


class TranslatorClient:
    def __init__(self, url: str | None = None, timeout: float = 120):
        self.url = (url or os.environ.get("TRANSLATOR_URL", "http://translator:8080")).rstrip("/")
        self.timeout = timeout
        self.model = MODEL_NAME
        self._lock = asyncio.Lock()  # llama.cpp runs --parallel 1; queue here, not there

    async def healthy(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=3) as c:
                return (await c.get(f"{self.url}/health")).status_code == 200
        except httpx.HTTPError:
            return False

    async def translate(self, text: str, target: str, source: str | None = None) -> str:
        """Translate one sentence; guess the source if unknown, and retry echoes clause by clause."""
        if not text.strip():
            return ""
        source = source or detect_language(text)
        if source == target:
            return text.strip()
        out = await self._complete(text, target, source)
        if not looks_untranslated(text, out, target, source):
            return out
        # 1) same sentence, stricter prompt
        out2 = await self._complete(text, target, source, strict=True)
        if not looks_untranslated(text, out2, target, source):
            return out2
        # 2) clause by clause (long lyric lines with repeats are what the model gives up on)
        parts = split_clauses(text)
        if len(parts) > 1:
            outs = []
            for p in parts:
                o = await self._complete(p, target, source)
                if looks_untranslated(p, o, target, source):
                    o = await self._complete(p, target, source, strict=True)
                outs.append(o.strip().rstrip(".,;:"))
            return ", ".join(outs) + ("." if text.rstrip().endswith(".") else "")
        log.info("untranslated output kept for %r -> %s", text[:60], target)
        return out2

    async def _complete(self, text: str, target: str, source: str | None, strict: bool = False) -> str:
        body = {"prompt": build_prompt(text, target, source, strict), "temperature": 0,
                "n_predict": max(64, 4 * len(text)), "stop": STOP, "cache_prompt": True}
        async with self._lock:
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as c:
                    r = await c.post(f"{self.url}/completion", json=body)
            except httpx.HTTPError as e:
                raise TranslatorUnavailable(f"Translator unreachable: {e.__class__.__name__}") from None
        if r.status_code == 503:
            raise TranslatorUnavailable()
        r.raise_for_status()
        return clean_output(text, r.json().get("content", ""))


# --------------------------------------------------------------------------- mode switching
SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount"
LAST_USED = "parakeet.io/translate-last-used"
SEP_LAST_USED = "parakeet.io/separator-last-used"
DELETION_COST = "controller.kubernetes.io/pod-deletion-cost"


class ModeController:
    """asr mode: parakeet-asr=2, translator=0.  translate mode: parakeet-asr=1, translator=1.

    Runs inside every ASR pod (no separate controller). All state lives in the API
    server (Deployment replicas + an annotation), so both pods agree and patches are
    idempotent. The pod serving a translate request marks itself with a high
    pod-deletion-cost before scaling ASR to 1, so the ReplicaSet removes the *other* pod.
    """

    def __init__(self):
        self.ns = os.environ.get("POD_NAMESPACE", "default")
        self.pod = os.environ.get("HOSTNAME", "")
        self.asr = os.environ.get("ASR_DEPLOYMENT", "parakeet-asr")
        self.tr = os.environ.get("TRANSLATOR_DEPLOYMENT", "translator")
        self.asr_replicas = int(os.environ.get("ASR_REPLICAS", "2"))
        self.idle_s = float(os.environ.get("TRANSLATE_IDLE_MINUTES", "10")) * 60
        self.sep = os.environ.get("SEPARATOR_DEPLOYMENT", "separator")
        self.sep_idle_s = float(os.environ.get("SEPARATOR_IDLE_MINUTES", "5")) * 60
        self._sep_last = 0.0
        self.enabled = os.path.exists(f"{SA_DIR}/token") and os.environ.get("TRANSLATE_MODE_SWITCH", "1") == "1"
        self.api = "https://kubernetes.default.svc"
        self._task: asyncio.Task | None = None
        self._local_last = 0.0

    def _client(self) -> httpx.AsyncClient:
        token = open(f"{SA_DIR}/token").read().strip()
        ctx = ssl.create_default_context(cafile=f"{SA_DIR}/ca.crt")
        return httpx.AsyncClient(base_url=self.api, verify=ctx, timeout=10,
                                 headers={"Authorization": f"Bearer {token}"})

    async def _patch(self, c, path: str, body: dict) -> None:
        r = await c.patch(path, json=body, headers={"Content-Type": "application/merge-patch+json"})
        r.raise_for_status()

    def _dep(self, name: str) -> str:
        return f"/apis/apps/v1/namespaces/{self.ns}/deployments/{name}"

    async def status(self) -> dict:
        if not self.enabled:
            return {"mode": "unmanaged"}
        try:
            async with self._client() as c:
                tr = (await c.get(self._dep(self.tr))).json()
                asr = (await c.get(self._dep(self.asr))).json()
        except Exception as e:  # noqa: BLE001
            return {"mode": "unknown", "error": str(e)}
        want = tr.get("spec", {}).get("replicas", 0)
        ready = tr.get("status", {}).get("readyReplicas", 0) or 0
        mode = "asr" if not want else ("translate" if ready else "warming")
        return {"mode": mode, "asr_replicas": asr.get("spec", {}).get("replicas"),
                "translator_ready": bool(ready),
                "translate_last_used": tr.get("metadata", {}).get("annotations", {}).get(LAST_USED),
                "idle_minutes": self.idle_s / 60}

    async def ensure_translate_mode(self) -> None:
        """Idempotent: mark use, protect this pod, scale ASR down and translator up."""
        if not self.enabled:
            return
        now = time.time()
        async with self._client() as c:
            if now - self._local_last > 30:  # throttle annotation writes
                self._local_last = now
                await self._patch(c, self._dep(self.tr), {"metadata": {"annotations": {
                    LAST_USED: datetime.now(timezone.utc).isoformat(timespec="seconds")}}})
            tr = (await c.get(self._dep(self.tr))).json()
            if tr["spec"].get("replicas", 0) >= 1:
                return
            log.info("switching to translate mode (requested on %s)", self.pod)
            # Keep the pod that is serving this request; the other one gets removed.
            await self._patch(c, f"/api/v1/namespaces/{self.ns}/pods/{self.pod}",
                              {"metadata": {"annotations": {DELETION_COST: "1000"}}})
            await self._patch(c, self._dep(self.asr) + "/scale", {"spec": {"replicas": 1}})
            await self._patch(c, self._dep(self.tr) + "/scale", {"spec": {"replicas": 1}})

    async def ensure_separator(self) -> None:
        """Only called for an explicit vocal-removal request: mark use and scale the separator to 1."""
        if not self.enabled:
            return
        async with self._client() as c:
            now = time.time()
            if now - self._sep_last > 20:
                self._sep_last = now
                await self._patch(c, self._dep(self.sep), {"metadata": {"annotations": {
                    SEP_LAST_USED: datetime.now(timezone.utc).isoformat(timespec="seconds")}}})
            dep = (await c.get(self._dep(self.sep))).json()
            if dep["spec"].get("replicas", 0) < 1:
                log.info("starting the separator (requested on %s)", self.pod)
                await self._patch(c, self._dep(self.sep) + "/scale", {"spec": {"replicas": 1}})

    async def _translator_tick(self, c) -> None:
        tr = (await c.get(self._dep(self.tr))).json()
        if not tr["spec"].get("replicas", 0):
            return
        last = tr["metadata"].get("annotations", {}).get(LAST_USED)
        age = (time.time() - datetime.fromisoformat(last).timestamp()) if last else 1e9
        if age < self.idle_s:
            return
        log.info("translator idle %.0fs: back to asr mode", age)
        await self._patch(c, self._dep(self.tr) + "/scale", {"spec": {"replicas": 0}})
        await self._patch(c, self._dep(self.asr) + "/scale", {"spec": {"replicas": self.asr_replicas}})
        await self._patch(c, f"/api/v1/namespaces/{self.ns}/pods/{self.pod}",
                          {"metadata": {"annotations": {DELETION_COST: None}}})

    async def _separator_tick(self, c) -> None:
        r = await c.get(self._dep(self.sep))
        if r.status_code == 404:
            return
        dep = r.json()
        if not dep["spec"].get("replicas", 0):
            return
        last = dep["metadata"].get("annotations", {}).get(SEP_LAST_USED)
        age = (time.time() - datetime.fromisoformat(last).timestamp()) if last else 1e9
        if age >= self.sep_idle_s:
            log.info("separator idle %.0fs: scaling to 0", age)
            await self._patch(c, self._dep(self.sep) + "/scale", {"spec": {"replicas": 0}})

    async def _idle_loop(self) -> None:
        while True:
            await asyncio.sleep(30)
            for tick in (self._translator_tick, self._separator_tick):
                try:
                    async with self._client() as c:
                        await tick(c)
                except Exception:  # noqa: BLE001 - keep looping; next tick retries
                    log.exception("idle check failed (%s)", tick.__name__)

    def start(self) -> None:
        if self.enabled:
            self._task = asyncio.create_task(self._idle_loop(), name="translate-idle")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
