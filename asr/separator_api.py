"""On-demand separator pod (Deployment `separator`, 0 replicas when idle).

ASR pods scale it to 1 only when a client explicitly asks for vocal removal, and back to 0 after
SEPARATOR_IDLE_MINUTES. Internal only (ClusterIP): POST /separate {"job_id"} -> 202; one job at a
time; progress in JOBS_DIR/<id>/sep.json; outputs vocals.wav + instrumental.wav (44.1 kHz stereo).

Device per job: CUDA with SEPARATOR_MODEL (htdemucs_ft) if >= SEPARATOR_MIN_FREE_VRAM_MB free,
else CPU with SEPARATOR_CPU_MODEL (htdemucs, ~4x faster than _ft on CPU). CUDA OOM retries on CPU.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from asr import separate as S
from asr.jobs import JOBS_DIR, _ID

log = logging.getLogger("separator")
GPU_MODEL = os.environ.get("SEPARATOR_MODEL", "htdemucs_ft")
CPU_MODEL = os.environ.get("SEPARATOR_CPU_MODEL", "htdemucs")
app = FastAPI(title="parakeet-separator")
_lock = asyncio.Lock()
_state = {"running": None, "done": 0}
_tasks: set = set()


class SeparateRequest(BaseModel):
    job_id: str


def _write(d: Path, **data) -> None:
    tmp = d / ".sep.tmp"
    tmp.write_text(json.dumps({**data, "updated": time.time()}))
    tmp.replace(d / "sep.json")


def _work(d: Path) -> None:
    import torch
    src = next(iter(sorted(d.glob("input.*"))))
    _write(d, state="running", stage="decoding", progress=0.0)
    mix = S.load_stereo(str(src))
    cur = {"device": S.pick_device()}
    cur["model"] = GPU_MODEL if cur["device"] == "cuda" else CPU_MODEL

    def prog(p: float):
        if not d.is_dir():
            raise RuntimeError("job deleted")
        _write(d, state="running", stage=f"separating on {cur['device'].upper()}",
               progress=round(p, 3), **cur)

    try:
        st = S.separate(mix, cur["model"], cur["device"], progress=prog)
    except torch.OutOfMemoryError:
        torch.cuda.empty_cache()
        cur.update(device="cpu", model=CPU_MODEL)
        log.warning("CUDA OOM, retrying on CPU")
        st = S.separate(mix, cur["model"], "cpu", progress=prog)
    S.write_wav(str(d / "vocals.wav"), st.vocals)
    S.write_wav(str(d / "instrumental.wav"), st.instrumental)
    peak = 0
    if cur["device"] == "cuda":
        peak = round(torch.cuda.max_memory_reserved() / 2**20)
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
    _write(d, state="done", stage="separated", progress=1.0, seconds=round(st.seconds, 1),
           peak_vram_mib=peak, **cur)


async def _run(d: Path) -> None:
    async with _lock:
        _state["running"] = d.name
        try:
            await asyncio.to_thread(_work, d)
        except Exception as e:  # noqa: BLE001
            log.exception("separation failed")
            if d.is_dir():
                _write(d, state="failed", progress=0.0, error=f"{e.__class__.__name__}: {e}"[:300])
        finally:
            _state["running"] = None
            _state["done"] += 1


@app.post("/separate", status_code=202)
async def separate(req: SeparateRequest):
    d = Path(JOBS_DIR) / req.job_id
    if not _ID.match(req.job_id) or not d.is_dir():
        return JSONResponse({"err_code": "NOT_FOUND", "err_msg": "no such job", "request_id": ""}, 404)
    _write(d, state="queued", stage="waiting for the separator", progress=0.0)
    t = asyncio.create_task(_run(d))
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)
    return {"job_id": req.job_id, "state": "queued"}


@app.get("/healthz")
async def healthz():
    return {"status": "ok", **_state, "gpu_model": GPU_MODEL, "cpu_model": CPU_MODEL}
