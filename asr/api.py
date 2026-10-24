"""FastAPI app exposing a Deepgram-compatible POST /v1/listen."""
from __future__ import annotations

import asyncio
import io
import uuid
from contextlib import asynccontextmanager

import soundfile as sf
from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from asr.engine import MODEL_NAME, SAMPLE_RATE, ParakeetEngine, to_mono_16k
from asr.schemas import (Alternative, Channel, ErrorResponse, ListenResponse,
                         Metadata, Results, Utterance)
from asr.worker import GpuWorker, QueueFull

MAX_BYTES = 200 * 1024 * 1024
TIMEOUT_S = 300


class ApiError(Exception):
    def __init__(self, status: int, code: str, msg: str):
        self.status, self.code, self.msg = status, code, msg


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Loading takes seconds and touches CUDA: do it off the loop, once.
    engine = await asyncio.to_thread(ParakeetEngine)
    app.state.worker = GpuWorker(engine)
    app.state.worker.start()
    yield
    await app.state.worker.stop()


app = FastAPI(title="parakeet-asr", lifespan=lifespan)


@app.middleware("http")
async def add_request_id(request: Request, call_next):
    request.state.request_id = str(uuid.uuid4())
    response = await call_next(request)
    response.headers["dg-request-id"] = request.state.request_id
    return response


def _error(request: Request, status: int, code: str, msg: str) -> JSONResponse:
    body = ErrorResponse(err_code=code, err_msg=msg,
                         request_id=getattr(request.state, "request_id", ""))
    return JSONResponse(body.model_dump(), status_code=status)


@app.exception_handler(ApiError)
async def api_error_handler(request: Request, exc: ApiError):
    return _error(request, exc.status, exc.code, exc.msg)


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError):
    return _error(request, 400, "Bad Request", str(exc.errors()))


@app.exception_handler(Exception)
async def unhandled_handler(request: Request, exc: Exception):
    return _error(request, 500, "INTERNAL_SERVER_ERROR", "Unexpected error")


@app.post("/v1/listen", response_model=ListenResponse)
async def listen(
    request: Request,
    utterances: bool = Query(False, description="Return timed segments"),
    model: str = Query("parakeet", description="Accepted for Deepgram compatibility"),
):
    body = await request.body()
    if not body:
        raise ApiError(400, "Bad Request", "Request body is empty; send raw audio bytes.")
    if len(body) > MAX_BYTES:
        raise ApiError(413, "PAYLOAD_TOO_LARGE", "Audio exceeds 200 MB.")

    try:  # decoding is CPU work too, keep it off the loop
        audio, sr = await asyncio.to_thread(sf.read, io.BytesIO(body), dtype="float32")
    except Exception:
        raise ApiError(400, "UNSUPPORTED_AUDIO", "Could not decode audio.") from None
    audio = await asyncio.to_thread(to_mono_16k, audio, sr)

    try:
        segments = await asyncio.wait_for(request.app.state.worker.submit(audio), TIMEOUT_S)
    except QueueFull:
        raise ApiError(503, "SERVER_BUSY", "Too many pending requests, retry later.") from None
    except asyncio.TimeoutError:
        raise ApiError(504, "TIMEOUT", "Transcription timed out.") from None

    transcript = " ".join(s.text.strip() for s in segments if s.text.strip())
    return ListenResponse(
        metadata=Metadata(request_id=request.state.request_id,
                          duration=round(len(audio) / SAMPLE_RATE, 3),
                          models=[MODEL_NAME]),
        results=Results(
            channels=[Channel(alternatives=[Alternative(transcript=transcript)])],
            utterances=[Utterance(start=s.start, end=s.end, transcript=s.text)
                        for s in segments] if utterances else None,
        ),
    )
