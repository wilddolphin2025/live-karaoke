"""Deepgram-compatible response and error models."""
from __future__ import annotations

from pydantic import BaseModel, Field


class Translation(BaseModel):
    """Deepgram's shape: alternatives[].translations[] = {language, translation}."""
    language: str
    translation: str


class Sentence(BaseModel):
    text: str
    start: float
    end: float


class Paragraph(BaseModel):
    sentences: list[Sentence]
    start: float
    end: float
    num_words: int = 0


class Paragraphs(BaseModel):
    """Deepgram's ?paragraphs=true shape: alternatives[].paragraphs."""
    transcript: str
    paragraphs: list[Paragraph]


class Alternative(BaseModel):
    transcript: str
    confidence: float = 1.0
    words: list[dict] = []
    paragraphs: Paragraphs | None = None
    translations: list[Translation] | None = None


class Channel(BaseModel):
    alternatives: list[Alternative]
    detected_language: str | None = None  # Deepgram field; set when language=auto (text-based guess)


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


# ---- POST /v1/translate (extension, not in Deepgram)
class TranslateSentence(BaseModel):
    text: str
    start: float | None = None
    end: float | None = None


class TranslateRequest(BaseModel):
    target: str = "en"
    source: str | None = None  # ISO code of the text, or null/auto
    sentences: list[TranslateSentence] = Field(default_factory=list, max_length=64)


class TranslatedSentence(TranslateSentence):
    translation: str


class TranslateResponse(BaseModel):
    request_id: str
    model: str
    language: str
    source: str | None = None
    sentences: list[TranslatedSentence]
