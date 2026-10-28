"""Post-processing jobs (extension, not Deepgram): vocal removal ("karaoke") + vocals-stem transcript.

Only ever started when a request explicitly asks for it (POST /v1/separate or /v1/listen?separate=vocals),
and only *after* the transcript/translation response is sent, so near-realtime delivery is never delayed.

State lives on a hostPath shared by every ASR pod and the separator pod (JOBS_DIR, one directory per job,
status.json written atomically), so GET /v1/jobs/{id} works whichever ASR pod the Service picks.

Pipeline (run by the ASR pod that accepted the job):
  1. separating   (progress 0.00-0.80) scale the on-demand `separator` Deployment to 1, POST /separate,
                  follow /jobs/<id>/sep.json written by the separator (Demucs, chunked)
  2. transcribing (0.80-0.90) ASR on the *vocals stem* through this pod's normal GPU queue
  3. muxing       (0.90-1.00) ffmpeg: video -> -c:v copy + instrumental audio; audio -> instrumental mp3
  4. done         karaoke file + transcript kept until expires_at (JOB_TTL_MINUTES), then deleted
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from typing import Awaitable, Callable

import httpx
import numpy as np

log = logging.getLogger("jobs")

JOBS_DIR = os.environ.get("JOBS_DIR", "/jobs")
JOB_TTL_S = float(os.environ.get("JOB_TTL_MINUTES", "60")) * 60
STALE_S = float(os.environ.get("JOB_STALE_S", "600"))          # no heartbeat this long -> JOB_LOST
MAX_ACTIVE = int(os.environ.get("JOBS_MAX_ACTIVE", "3"))
MIN_FREE_GB = float(os.environ.get("JOBS_MIN_FREE_GB", "5"))
SEPARATOR_URL = os.environ.get("SEPARATOR_URL", "http://separator:8001")
SEPARATOR_WAIT_S = float(os.environ.get("SEPARATOR_WAIT_S", "600"))
TERMINAL = {"done", "failed", "cancelled"}
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm"}
_ID = re.compile(r"^[0-9a-f]{32}$")


class JobError(Exception):
    def __init__(self, code: str, msg: str):
        super().__init__(msg)
        self.code, self.msg = code, msg


class Cancelled(Exception):
    pass


class JobStore:
    def __init__(self, root: str = JOBS_DIR, ttl_s: float = JOB_TTL_S, stale_s: float = STALE_S):
        self.root, self.ttl_s, self.stale_s = Path(root), ttl_s, stale_s

    @staticmethod
    def new_id() -> str:
        return uuid.uuid4().hex

    def dir(self, job_id: str) -> Path:
        if not _ID.match(job_id or ""):
            raise KeyError(job_id)
        return self.root / job_id

    def _write(self, job_id: str, data: dict) -> None:
        d = self.dir(job_id)
        if not d.is_dir():
            raise Cancelled(job_id)
        tmp = d / f".status.{os.getpid()}.tmp"
        tmp.write_text(json.dumps(data, ensure_ascii=False))
        tmp.replace(d / "status.json")

    def create(self, job_id: str, *, filename: str, language: str, request_id: str) -> dict:
        self.root.mkdir(parents=True, exist_ok=True)
        self.dir(job_id).mkdir()
        now = time.time()
        data = {"job_id": job_id, "type": "separate", "status": "queued", "stage": "queued", "progress": 0.0,
                "created": now, "updated": now, "expires_at": now + self.ttl_s, "filename": filename,
                "language": language, "request_id": request_id, "error": None, "result": None}
        self._write(job_id, data)
        return data

    def read(self, job_id: str) -> dict | None:
        try:
            data = json.loads((self.dir(job_id) / "status.json").read_text())
        except (KeyError, OSError, ValueError):
            return None
        if data["status"] not in TERMINAL and time.time() - data.get("updated", 0) > self.stale_s:
            data.update(status="failed", error={"err_code": "JOB_LOST",
                        "err_msg": "The pod running this job went away (e.g. a mode switch); submit it again."})
        return data

    def update(self, job_id: str, **fields) -> dict:
        data = json.loads((self.dir(job_id) / "status.json").read_text()) if self.dir(job_id).is_dir() else None
        if data is None:
            raise Cancelled(job_id)
        if data["status"] == "cancelled":
            raise Cancelled(job_id)
        data.update(fields, updated=time.time())
        self._write(job_id, data)
        return data

    def ids(self) -> list[str]:
        if not self.root.is_dir():
            return []
        return [p.name for p in self.root.iterdir() if _ID.match(p.name)]

    def active_count(self) -> int:
        return sum(1 for i in self.ids() if (d := self.read(i)) and d["status"] not in TERMINAL)

    def free_gb(self) -> float:
        self.root.mkdir(parents=True, exist_ok=True)
        return shutil.disk_usage(self.root).free / 2**30

    def delete(self, job_id: str) -> bool:
        d = self.dir(job_id)
        if not d.is_dir():
            return False
        shutil.rmtree(d, ignore_errors=True)
        return True

    def cleanup(self, now: float | None = None) -> list[str]:
        """Delete expired jobs (and orphan dirs without status older than the TTL)."""
        now = now or time.time()
        gone = []
        for i in self.ids():
            d = self.read(i)
            exp = d["expires_at"] if d else (self.root / i).stat().st_mtime + self.ttl_s
            if now >= exp:
                shutil.rmtree(self.root / i, ignore_errors=True)
                gone.append(i)
        return gone

    def input_path(self, job_id: str) -> Path | None:
        return next(iter(sorted(self.dir(job_id).glob("input.*"))), None)


def media_ext(filename: str, content_type: str | None) -> str:
    ext = Path(filename or "").suffix.lower()
    if re.fullmatch(r"\.[a-z0-9]{1,5}", ext):
        return ext
    ct = (content_type or "").split(";")[0].strip().lower()
    return {"video/mp4": ".mp4", "video/quicktime": ".mov", "video/x-matroska": ".mkv", "video/webm": ".webm",
            "audio/webm": ".webm", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav",
            "audio/flac": ".flac", "audio/ogg": ".ogg", "audio/mp4": ".m4a"}.get(ct, ".bin")


def probe(path: str) -> dict:
    """{'audio': bool, 'video': bool, 'vcodec': str|None}; cover art (attached_pic) is not video."""
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name:stream_disposition=attached_pic",
                          "-of", "json", path], capture_output=True, text=True, timeout=60)
    streams = json.loads(out.stdout or "{}").get("streams", []) if out.returncode == 0 else []
    vids = [s for s in streams if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")]
    return {"audio": any(s.get("codec_type") == "audio" for s in streams), "video": bool(vids),
            "vcodec": vids[0].get("codec_name") if vids else None}


def output_name(src: Path, is_video: bool, vcodec: str | None) -> str:
    if not is_video:
        return "karaoke.mp3"
    ext = src.suffix.lower()
    if ext == ".webm" and vcodec not in ("vp8", "vp9", "av1"):
        ext = ".mkv"
    return f"karaoke{ext if ext in VIDEO_EXT else '.mkv'}"


class HttpSeparator:
    """Talks to the on-demand separator pod: scale it up, start a job, follow sep.json."""

    def __init__(self, modes, url: str = SEPARATOR_URL, wait_s: float = SEPARATOR_WAIT_S):
        self.modes, self.url, self.wait_s = modes, url.rstrip("/"), wait_s

    async def _healthy(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=3) as c:
                return (await c.get(f"{self.url}/healthz")).status_code == 200
        except httpx.HTTPError:
            return False

    async def run(self, store: JobStore, job_id: str, on_progress: Callable[[float, dict], Awaitable[None]]) -> dict:
        deadline = time.time() + self.wait_s
        await self.modes.ensure_separator()
        while not await self._healthy():
            if time.time() > deadline:
                raise JobError("SEPARATOR_UNAVAILABLE", "The separator pod did not start in time.")
            await on_progress(0.0, {"stage": "starting separator"})
            await asyncio.sleep(3)
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(f"{self.url}/separate", json={"job_id": job_id})
        if r.status_code >= 400:
            raise JobError("SEPARATOR_ERROR", f"separator answered {r.status_code}: {r.text[:200]}")
        sep = store.dir(job_id) / "sep.json"
        last_beat = 0.0
        while True:
            await asyncio.sleep(2)
            if time.time() - last_beat > 30:   # keeps the separator from idling to 0 while we use it
                last_beat = time.time()
                try:
                    await self.modes.ensure_separator()
                except Exception:  # noqa: BLE001
                    log.exception("separator heartbeat failed")
            try:
                s = json.loads(sep.read_text())
            except (OSError, ValueError):
                s = {"state": "queued", "progress": 0.0}
            if s.get("state") == "done":
                return s
            if s.get("state") == "failed":
                raise JobError("SEPARATION_FAILED", s.get("error") or "Demucs failed")
            await on_progress(float(s.get("progress", 0.0)), {"stage": s.get("stage", "separating"),
                                                               "device": s.get("device"), "model": s.get("model")})


async def run_job(store: JobStore, job_id: str, *, separator, transcribe, build_result) -> None:
    """separator.run(store, id, on_progress) -> sep info; transcribe(audio16k, language) -> segments;
    build_result(segments, duration) -> Deepgram-shaped dict for the vocals-stem transcript."""
    d = store.dir(job_id)
    t0 = time.time()
    try:
        job = store.read(job_id)
        src = store.input_path(job_id)
        if src is None:
            raise JobError("NO_INPUT", "Job has no media.")
        info = await asyncio.to_thread(probe, str(src))
        if not info["audio"]:
            raise JobError("UNSUPPORTED_AUDIO", "No audio stream found in the media.")
        store.update(job_id, status="separating", stage="separating", is_video=info["video"])

        async def on_sep(p: float, extra: dict):
            store.update(job_id, progress=round(0.8 * p, 3), **{k: v for k, v in extra.items() if v is not None})

        sep = await separator.run(store, job_id, on_sep)
        t_sep = time.time() - t0
        store.update(job_id, status="transcribing", stage="transcribing vocals", progress=0.8,
                     device=sep.get("device"), model=sep.get("model"))

        from asr.engine import SAMPLE_RATE, to_mono_16k
        import soundfile as sf
        audio, sr = await asyncio.to_thread(sf.read, str(d / "vocals.wav"), dtype="float32")
        audio = to_mono_16k(audio, sr)
        t1 = time.time()
        segments = await transcribe(audio, job.get("language", "auto"))
        t_asr = time.time() - t1
        store.update(job_id, status="muxing", stage="writing karaoke file", progress=0.9)

        from asr.separate import mux_command
        name = output_name(src, info["video"], info["vcodec"])
        cmd = mux_command(str(src), str(d / "instrumental.wav"), str(d / name), info["video"])
        p = await asyncio.create_subprocess_exec(*cmd, stderr=asyncio.subprocess.PIPE)
        _, err = await p.communicate()
        if p.returncode != 0:
            raise JobError("MUX_FAILED", err.decode(errors="replace")[-300:])
        result = build_result(segments, round(len(audio) / SAMPLE_RATE, 3))
        for f in [src, d / "vocals.wav", d / "instrumental.wav"]:   # keep only what the client downloads
            f.unlink(missing_ok=True)
        now = time.time()
        store.update(job_id, status="done", stage="done", progress=1.0, expires_at=now + store.ttl_s,
                     output=name, is_video=info["video"], size=(d / name).stat().st_size,
                     timings={"separate_s": round(t_sep, 1), "asr_s": round(t_asr, 1),
                              "mux_s": round(now - t1 - t_asr, 1), "total_s": round(now - t0, 1)},
                     result=result)
    except Cancelled:
        log.info("job %s cancelled", job_id)
    except JobError as e:
        _fail(store, job_id, e.code, e.msg)
    except Exception as e:  # noqa: BLE001
        log.exception("job %s failed", job_id)
        _fail(store, job_id, "INTERNAL_SERVER_ERROR", f"{e.__class__.__name__}: {e}"[:300])


def _fail(store: JobStore, job_id: str, code: str, msg: str) -> None:
    try:
        store.update(job_id, status="failed", stage="failed", error={"err_code": code, "err_msg": msg})
        for f in store.dir(job_id).glob("*.wav"):
            f.unlink(missing_ok=True)
    except Exception:  # noqa: BLE001
        pass


async def cleanup_loop(store: JobStore, every_s: float = 300) -> None:
    while True:
        try:
            gone = await asyncio.to_thread(store.cleanup)
            if gone:
                log.info("deleted %d expired jobs", len(gone))
        except Exception:  # noqa: BLE001
            log.exception("job cleanup failed")
        await asyncio.sleep(every_s)
