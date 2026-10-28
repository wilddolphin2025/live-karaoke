"""FastAPI app exposing a Deepgram-compatible POST /v1/listen."""
from __future__ import annotations

import asyncio
import logging
import os
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from asr.audio import UndecodableAudio, decode
from asr.engine import SAMPLE_RATE, ParakeetEngine
from asr.schemas import (Alternative, Channel, ErrorResponse, ListenResponse, Metadata,
                         Paragraph, Paragraphs, Results, Sentence, TranslatedSentence,
                         TranslateRequest, TranslateResponse, Translation, Utterance)
from asr.sentences import sentences as split_sentences
from asr.translate import (LANGUAGES, ModeController, TranslatorClient,
                           TranslatorUnavailable, UnsupportedLanguage, normalize_lang,
                           parse_targets)
from asr.worker import GpuOutOfMemory, GpuWorker, QueueFull

APP_VERSION = "0.5.0"
GIT_SHA = os.environ.get("GIT_SHA", "unknown")
HOSTNAME = os.environ.get("HOSTNAME", "unknown")
MAX_BYTES = 200 * 1024 * 1024
TIMEOUT_S = 300
# How long a translate request waits for the translator before answering 503 + Retry-After.
TRANSLATE_WAIT_S = float(os.environ.get("TRANSLATE_WAIT_S", "20"))
RETRY_AFTER_S = 15


class ApiError(Exception):
    def __init__(self, status: int, code: str, msg: str, headers: dict | None = None):
        self.status, self.code, self.msg, self.headers = status, code, msg, headers or {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Loading takes seconds and touches CUDA: do it off the loop, once.
    engine = await asyncio.to_thread(ParakeetEngine)
    app.state.worker = GpuWorker(engine)
    app.state.worker.start()
    app.state.translator = TranslatorClient()
    app.state.modes = ModeController()
    app.state.modes.start()
    yield
    await app.state.modes.stop()
    await app.state.worker.stop()


app = FastAPI(title="parakeet-asr", lifespan=lifespan)


@app.middleware("http")
async def add_request_id(request: Request, call_next):
    request.state.request_id = str(uuid.uuid4())
    response = await call_next(request)
    response.headers["dg-request-id"] = request.state.request_id
    response.headers["x-served-by"] = HOSTNAME
    return response


def _error(request: Request, status: int, code: str, msg: str) -> JSONResponse:
    body = ErrorResponse(err_code=code, err_msg=msg,
                         request_id=getattr(request.state, "request_id", ""))
    return JSONResponse(body.model_dump(), status_code=status)


@app.exception_handler(ApiError)
async def api_error_handler(request: Request, exc: ApiError):
    resp = _error(request, exc.status, exc.code, exc.msg)
    resp.headers.update(exc.headers)
    return resp


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError):
    return _error(request, 400, "Bad Request", str(exc.errors()))


@app.exception_handler(Exception)
async def unhandled_handler(request: Request, exc: Exception):
    return _error(request, 500, "INTERNAL_SERVER_ERROR", "Unexpected error")


@app.get("/healthz", include_in_schema=False)
async def healthz(request: Request):
    """Liveness: is the process and its GPU worker task alive?"""
    task = request.app.state.worker._task
    if task is None or task.done():
        raise ApiError(500, "WORKER_DEAD", "GPU worker task has stopped.")
    return {"status": "ok"}


@app.get("/readyz", include_in_schema=False)
async def readyz(request: Request):
    """Readiness: model loaded and the queue has room. A full queue takes the pod
    out of the Service so new traffic goes to the other replica."""
    q = request.app.state.worker.queue
    if q.full():
        raise ApiError(503, "SERVER_BUSY", "Queue full.")
    return {"status": "ready", "pending": q.qsize()}


def _versions() -> dict:
    import torch
    try:
        from importlib.metadata import version
        nemo_version = version("nemo-toolkit")
    except Exception:
        nemo_version = "unknown"
    gpu = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
    return {"nemo_version": nemo_version, "torch_version": torch.__version__, "gpu": gpu}


@app.get("/v1/info")
async def info(request: Request):
    """Service, model and pod versions (shown in the Chrome extension footer)."""
    engine = request.app.state.worker.engine
    if not hasattr(request.app.state, "versions"):
        request.app.state.versions = await asyncio.to_thread(_versions)
    return {
        "service_version": f"{APP_VERSION}+{GIT_SHA}",
        "app_version": APP_VERSION,
        "git_sha": GIT_SHA,
        "model": engine.model_name,
        **request.app.state.versions,
        "pod": HOSTNAME,
        "word_timestamps": getattr(engine, "word_timestamps", False),
        "translation": {"model": request.app.state.translator.model,
                        "languages": sorted(LANGUAGES),
                        **(await request.app.state.modes.status())},
    }


async def _ready_translator(app) -> None:
    """Switch the cluster to translate mode if needed and wait briefly for the translator."""
    try:
        await app.state.modes.ensure_translate_mode()
    except Exception:  # RBAC/API trouble: still try the translator if it happens to be up
        logging.getLogger("translate").exception("mode switch failed")
    deadline = asyncio.get_running_loop().time() + TRANSLATE_WAIT_S
    while not await app.state.translator.healthy():
        if asyncio.get_running_loop().time() >= deadline:
            raise ApiError(503, "TRANSLATOR_WARMING_UP",
                           "Switching to translate mode (one ASR pod + translator); retry shortly.",
                           {"Retry-After": str(RETRY_AFTER_S)})
        await asyncio.sleep(2)


async def _translate_segments(translator, texts: list[str], targets: list[str], source: str | None):
    """{target: [translation per segment]}; sequential, the translator handles one at a time."""
    out: dict[str, list[str]] = {}
    for t in targets:
        out[t] = [await translator.translate(x, t, source) for x in texts]
    return out


def _paragraphs(segments, transcript: str) -> Paragraphs:
    paras = []
    for s in segments:
        sents = split_sentences([s])
        if sents:
            paras.append(Paragraph(sentences=[Sentence(text=x.text, start=x.start, end=x.end) for x in sents],
                                   start=sents[0].start, end=sents[-1].end,
                                   num_words=sum(len(x.text.split()) for x in sents)))
    return Paragraphs(transcript=transcript, paragraphs=paras)


@app.post("/v1/translate", response_model=TranslateResponse)
async def translate_sentences(request: Request, body: TranslateRequest):
    """Extension (not Deepgram): translate timed sentences, echoing start/end.

    Meant for progressive clients: call /v1/listen?paragraphs=true first, then send
    sentences here one or a few at a time. An empty list only warms the translator
    (starts the mode switch). 503 + Retry-After while warming, like /v1/listen."""
    try:
        target = parse_targets(body.target)
        if len(target) != 1:
            raise UnsupportedLanguage(body.target)
        target = target[0]
        source = None if body.source in (None, "", "auto") else normalize_lang(body.source)
    except UnsupportedLanguage as e:
        raise ApiError(400, "Bad Request", f"Unsupported language: {e}. "
                       f"Supported: {', '.join(sorted(LANGUAGES))}") from None
    await _ready_translator(request.app)
    out = []
    try:
        for s in body.sentences:
            out.append(TranslatedSentence(**s.model_dump(),
                                          translation=await request.app.state.translator.translate(s.text, target, source)))
    except TranslatorUnavailable as e:
        raise ApiError(503, "TRANSLATOR_UNAVAILABLE", str(e), {"Retry-After": str(e.retry_after)}) from None
    return TranslateResponse(request_id=request.state.request_id, model=request.app.state.translator.model,
                             language=target, source=source, sentences=out)


@app.post("/v1/listen", response_model=ListenResponse, response_model_exclude_none=True)
async def listen(
    request: Request,
    utterances: bool = Query(False, description="Return timed segments"),
    model: str = Query("parakeet", description="Accepted for Deepgram compatibility"),
    language: str = Query("auto", pattern="^(auto|bg|cs|da|de|el|en|es|et|fi|fr|hr|hu|it|lt|lv|mt|nl|pl|pt|ro|ru|sk|sl|sv|uk)$",
                          description="ISO 639-1 code of the speech, or auto"),
    translate: str | None = Query(None, description="Target language code(s), comma-separated, e.g. en or en,de (Deepgram name)"),
    paragraphs: bool = Query(False, description="Deepgram paragraphs: timed sentences per paragraph"),
):
    targets: list[str] = []
    if translate:
        try:
            targets = parse_targets(translate)
        except UnsupportedLanguage as e:
            raise ApiError(400, "Bad Request", f"Unsupported translate language: {e}. "
                           f"Supported: {', '.join(sorted(LANGUAGES))}") from None
        await _ready_translator(request.app)  # 503 + Retry-After while warming, before spending ASR time

    body = await request.body()
    if not body:
        raise ApiError(400, "Bad Request", "Request body is empty; send raw audio bytes.")
    if len(body) > MAX_BYTES:
        raise ApiError(413, "PAYLOAD_TOO_LARGE", "Audio exceeds 200 MB.")

    try:  # soundfile, then ffmpeg for mp4/m4a/mov/mkv/webm and other containers
        audio = await decode(body)
    except UndecodableAudio:
        raise ApiError(400, "UNSUPPORTED_AUDIO", "Could not decode audio (tried soundfile and ffmpeg).") from None

    try:
        segments = await asyncio.wait_for(request.app.state.worker.submit(audio, language), TIMEOUT_S)
    except QueueFull:
        raise ApiError(503, "SERVER_BUSY", "Too many pending requests, retry later.") from None
    except GpuOutOfMemory:
        raise ApiError(503, "GPU_OUT_OF_MEMORY", "GPU is out of memory, retry later.") from None
    except asyncio.TimeoutError:
        raise ApiError(504, "TIMEOUT", "Transcription timed out.") from None

    transcript = " ".join(s.text.strip() for s in segments if s.text.strip())
    seg_tr: dict[str, list[str]] = {}
    if targets:
        source = language if language != "auto" else None
        try:
            seg_tr = await _translate_segments(request.app.state.translator,
                                               [s.text for s in segments], targets, source)
        except TranslatorUnavailable as e:
            raise ApiError(503, "TRANSLATOR_UNAVAILABLE", str(e), {"Retry-After": str(e.retry_after)}) from None
    return ListenResponse(
        metadata=Metadata(request_id=request.state.request_id,
                          duration=round(len(audio) / SAMPLE_RATE, 3),
                          models=[request.app.state.worker.engine.model_name]
                          + ([request.app.state.translator.model] if targets else [])),
        results=Results(
            channels=[Channel(alternatives=[Alternative(
                transcript=transcript,
                words=[{"word": w.word, "start": w.start, "end": w.end,
                        "confidence": w.confidence, "punctuated_word": w.word}
                       for s in segments for w in s.words],
                paragraphs=_paragraphs(segments, transcript) if paragraphs else None,
                translations=[Translation(language=t, translation=" ".join(x.strip() for x in v if x.strip()))
                              for t, v in seg_tr.items()] if targets else None,
            )])],
            utterances=[Utterance(start=s.start, end=s.end, transcript=s.text,
                                  translations=[Translation(language=t, translation=v[i])
                                                for t, v in seg_tr.items()] if targets else None)
                        for i, s in enumerate(segments)] if utterances else None,
        ),
    )
