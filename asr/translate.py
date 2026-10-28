"""On-demand translation with nvidia/Riva-Translate-4B-Instruct-v2 (llama.cpp server).

Pieces:
  * language tables + Riva prompt building (mirrors the model card's chat template)
  * TranslatorClient: llama.cpp /completion calls, one segment at a time
  * ModeController: flips the cluster between "asr" mode (2 ASR pods) and
    "translate" mode (1 ASR pod + riva-translate) by patching Deployment scales
    through the Kubernetes API with the pod's ServiceAccount token.
"""
from __future__ import annotations

import asyncio
import logging
import os
import ssl
import time
from datetime import datetime, timezone

import httpx

log = logging.getLogger("translate")

# Codes and names exactly as the Riva-Translate-4B-Instruct-v2 chat template uses them.
LANGUAGES: dict[str, str] = {
    "en": "English", "ar": "Arabic", "bg": "Bulgarian", "cs": "Czech", "da": "Danish",
    "de": "German", "el": "Greek", "es": "European Spanish", "es-es": "European Spanish",
    "es-us": "Latin American Spanish", "et": "Estonian", "fi": "Finnish", "fr": "French",
    "hi": "Hindi", "hr": "Croatian", "hu": "Hungarian", "id": "Indonesian", "it": "Italian",
    "ja": "Japanese", "ko": "Korean", "lt": "Lithuanian", "lv": "Latvian", "nl": "Dutch",
    "no": "Norwegian", "pl": "Polish", "pt": "Brazilian Portuguese", "pt-br": "Brazilian Portuguese",
    "pt-pt": "European Portuguese", "ro": "Romanian", "ru": "Russian", "sk": "Slovak",
    "sl": "Slovenian", "sv": "Swedish", "th": "Thai", "tr": "Turkish", "uk": "Ukrainian",
    "vi": "Vietnamese", "zh": "Simplified Chinese", "zh-cn": "Simplified Chinese",
    "zh-tw": "Traditional Chinese",
}
_BY_NAME = {v.lower(): k for k, v in reversed(list(LANGUAGES.items()))}
_BY_NAME.update({"spanish": "es", "portuguese": "pt", "chinese": "zh",
                 "brazilian portuguese": "pt-br", "latin american spanish": "es-us"})
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


def build_prompt(text: str, target: str, source: str | None = None) -> str:
    """Raw prompt identical to the model's chat template output (add_generation_prompt=True).

    With a known source we get the specific system message; for auto we use the
    template's generic 'You are a translation expert.' but still name the target."""
    tgt = LANGUAGES[target]
    src = LANGUAGES.get(source or "")
    system = (f"You are an expert at translating text from {src} to {tgt}." if src
              else "You are a translation expert.")
    user = f"What is the {tgt} translation of the sentence: {text.strip()}"
    return f"<s>System\n{system}</s>\n<s>User\n{user}</s>\n<s>Assistant\n"


class TranslatorUnavailable(Exception):
    """Translator not ready (warming up, switching modes): retry later."""

    def __init__(self, msg: str = "Translator is warming up.", retry_after: int = 15):
        super().__init__(msg)
        self.retry_after = retry_after


class TranslatorClient:
    def __init__(self, url: str | None = None, timeout: float = 120):
        self.url = (url or os.environ.get("TRANSLATOR_URL", "http://riva-translate:8080")).rstrip("/")
        self.timeout = timeout
        self.model = os.environ.get("TRANSLATOR_MODEL", "nvidia/Riva-Translate-4B-Instruct-v2 (Q4_K_M GGUF)")
        self._lock = asyncio.Lock()  # llama.cpp runs --parallel 1; queue here, not there

    async def healthy(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=3) as c:
                return (await c.get(f"{self.url}/health")).status_code == 200
        except httpx.HTTPError:
            return False

    async def translate(self, text: str, target: str, source: str | None = None) -> str:
        if not text.strip():
            return ""
        body = {"prompt": build_prompt(text, target, source), "temperature": 0,
                "n_predict": max(64, 4 * len(text)), "stop": ["</s>", "<s>"], "cache_prompt": True}
        async with self._lock:
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as c:
                    r = await c.post(f"{self.url}/completion", json=body)
            except httpx.HTTPError as e:
                raise TranslatorUnavailable(f"Translator unreachable: {e.__class__.__name__}") from None
        if r.status_code == 503:
            raise TranslatorUnavailable()
        r.raise_for_status()
        return r.json().get("content", "").strip()


# --------------------------------------------------------------------------- mode switching
SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount"
LAST_USED = "parakeet.io/translate-last-used"
DELETION_COST = "controller.kubernetes.io/pod-deletion-cost"


class ModeController:
    """asr mode: parakeet-asr=2, riva-translate=0.  translate mode: parakeet-asr=1, riva-translate=1.

    Runs inside every ASR pod (no separate controller). All state lives in the API
    server (Deployment replicas + an annotation), so both pods agree and patches are
    idempotent. The pod serving a translate request marks itself with a high
    pod-deletion-cost before scaling ASR to 1, so the ReplicaSet removes the *other* pod.
    """

    def __init__(self):
        self.ns = os.environ.get("POD_NAMESPACE", "default")
        self.pod = os.environ.get("HOSTNAME", "")
        self.asr = os.environ.get("ASR_DEPLOYMENT", "parakeet-asr")
        self.tr = os.environ.get("TRANSLATOR_DEPLOYMENT", "riva-translate")
        self.asr_replicas = int(os.environ.get("ASR_REPLICAS", "2"))
        self.idle_s = float(os.environ.get("TRANSLATE_IDLE_MINUTES", "10")) * 60
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

    async def _idle_loop(self) -> None:
        while True:
            await asyncio.sleep(30)
            try:
                async with self._client() as c:
                    tr = (await c.get(self._dep(self.tr))).json()
                    if not tr["spec"].get("replicas", 0):
                        continue
                    last = tr["metadata"].get("annotations", {}).get(LAST_USED)
                    age = (time.time() - datetime.fromisoformat(last).timestamp()) if last else 1e9
                    if age < self.idle_s:
                        continue
                    log.info("translator idle %.0fs: back to asr mode", age)
                    await self._patch(c, self._dep(self.tr) + "/scale", {"spec": {"replicas": 0}})
                    await self._patch(c, self._dep(self.asr) + "/scale", {"spec": {"replicas": self.asr_replicas}})
                    await self._patch(c, f"/api/v1/namespaces/{self.ns}/pods/{self.pod}",
                                      {"metadata": {"annotations": {DELETION_COST: None}}})
            except Exception:  # noqa: BLE001 - keep looping; next tick retries
                log.exception("idle check failed")

    def start(self) -> None:
        if self.enabled:
            self._task = asyncio.create_task(self._idle_loop(), name="translate-idle")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
