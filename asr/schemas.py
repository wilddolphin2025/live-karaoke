"""Deepgram-compatible response and error models."""
from __future__ import annotations

from pydantic import BaseModel


class Translation(BaseModel):
    """Deepgram's shape: alternatives[].translations[] = {language, translation}."""
    language: str
    translation: str


class Alternative(BaseModel):
    transcript: str
    confidence: float = 1.0
    words: list[dict] = []
    translations: list[Translation] | None = None


class Channel(BaseModel):
    alternatives: list[Alternative]


class Utterance(BaseModel):
    start: float
    end: float
    transcript: str
    channel: int = 0
    translations: list[Translation] | None = None  # extension: Deepgram has none per utterance


class Results(BaseModel):
    channels: list[Channel]
    utterances: list[Utterance] | None = None


class Metadata(BaseModel):
    request_id: str
    duration: float
    channels: int = 1
    models: list[str]


class ListenResponse(BaseModel):
    metadata: Metadata
    results: Results


class ErrorResponse(BaseModel):
    """Deepgram error shape: {err_code, err_msg, request_id}."""
    err_code: str
    err_msg: str
    request_id: str
