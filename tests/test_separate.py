"""Vocal removal: chunking, job store, mux and the job API (fakes; no Demucs, no GPU)."""
import asyncio
import json
import shutil
import subprocess
import time
from types import SimpleNamespace

import numpy as np
import pytest

from asr import jobs as J
from asr import separate as S

ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg missing")


@pytest.mark.parametrize("n,chunk,ov", [(10, 100, 5), (1000, 300, 30), (1001, 300, 30), (5000, 1000, 0)])
def test_chunk_bounds_cover_everything(n, chunk, ov):
    b = S.chunk_bounds(n, chunk, ov)
    assert b[0][0] == 0 and b[-1][1] == n
    for (s0, e0), (s1, e1) in zip(b, b[1:]):
        assert s1 <= e0 and e0 - s1 <= ov + 1 and e1 > e0


def test_crossfade_join_is_identity_for_consistent_chunks():
    n, chunk, ov = 3000, 1000, 100
    x = np.random.default_rng(0).standard_normal((2, n)).astype(np.float32)
    parts = [(s, x[:, s:e].copy()) for s, e in S.chunk_bounds(n, chunk, ov)]
    np.testing.assert_allclose(S.crossfade_join(parts, n, ov), x, atol=1e-5)


def test_jobstore_lifecycle_ttl_and_stale(tmp_path):
    st = J.JobStore(str(tmp_path), ttl_s=100, stale_s=50)
    i = st.new_id()
    st.create(i, filename="a.mp4", language="es", request_id="r")
    (st.dir(i) / "input.mp4").write_bytes(b"x")
    assert st.input_path(i).name == "input.mp4" and st.active_count() == 1
    st.update(i, status="separating", progress=0.3)
    assert st.read(i)["progress"] == 0.3
    data = json.loads((st.dir(i) / "status.json").read_text())
    data["updated"] = time.time() - 60
    (st.dir(i) / "status.json").write_text(json.dumps(data))
    assert st.read(i)["error"]["err_code"] == "JOB_LOST"
    assert st.cleanup(now=time.time() + 10) == [] and st.cleanup(now=time.time() + 200) == [i]
    assert st.read(i) is None
    with pytest.raises(KeyError):
        st.dir("../etc")


def test_update_after_delete_cancels(tmp_path):
    st = J.JobStore(str(tmp_path))
    i = st.new_id()
    st.create(i, filename="a", language="auto", request_id="r")
    st.delete(i)
    with pytest.raises(J.Cancelled):
        st.update(i, progress=0.5)


def test_output_name_and_ext():
    from pathlib import Path
    assert J.output_name(Path("input.ogg"), False, None) == "karaoke.mp3"
    assert J.output_name(Path("input.mp4"), True, "h264") == "karaoke.mp4"
    assert J.output_name(Path("input.webm"), True, "h264") == "karaoke.mkv"
    assert J.media_ext("", "video/webm") == ".webm" and J.media_ext("x.MOV", None) == ".mov"


@ffmpeg
def test_mux_copies_video_and_replaces_audio(tmp_path):
    src, inst, dst = tmp_path / "in.mp4", tmp_path / "inst.wav", tmp_path / "out.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=2",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-c:a", "aac",
                    "-shortest", str(src)], check=True)
    S.write_wav(str(inst), np.zeros((2, S.SR * 2), dtype=np.float32))
    subprocess.run(S.mux_command(str(src), str(inst), str(dst), True), check=True, capture_output=True)
    info = J.probe(str(dst))
    assert info == {"audio": True, "video": True, "vcodec": "h264"}
    def vpackets(p):
        return subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                               "packet=size", "-of", "csv=p=0", str(p)], capture_output=True, text=True).stdout
    assert vpackets(src) == vpackets(dst)   # bit-identical video packets: -c:v copy


# ---- API with fakes
class _Sep:
    def __init__(self):
        self.calls = 0

    async def run(self, store, job_id, on_progress):
        self.calls += 1
        await on_progress(0.5, {"stage": "separating on CPU", "device": "cpu", "model": "htdemucs"})
        S.write_wav(str(store.dir(job_id) / "vocals.wav"), np.zeros((2, S.SR), dtype=np.float32))
        S.write_wav(str(store.dir(job_id) / "instrumental.wav"), np.zeros((2, S.SR), dtype=np.float32))
        return {"state": "done", "device": "cpu", "model": "htdemucs"}


@pytest.fixture
def client(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from asr import api
    from asr.engine import Segment, Word
    segs = [Segment(start=0.0, end=1.0, text="Hola amor.", words=(Word("Hola", 0.0, 0.4, 0.9), Word("amor.", 0.5, 1.0, 0.9)))]

    class Worker:
        engine = SimpleNamespace(model_name="fake-asr")
        async def submit(self, audio, language):
            return segs

    async def fake_decode(body):
        return np.zeros(16000, dtype=np.float32)

    monkeypatch.setattr(api, "decode", fake_decode)
    api.app.state.worker = Worker()
    api.app.state.jobs = J.JobStore(str(tmp_path))
    api.app.state.separator = _Sep()
    api.app.state.job_tasks = set()
    started = []

    async def fake_start(app, job_id):   # TestClient has no long-lived loop: run jobs explicitly
        started.append(job_id)
    monkeypatch.setattr(api, "_start_job", fake_start)
    c = TestClient(api.app)
    c.started = started

    def run(job_id):
        async def transcribe(audio, language):
            return segs
        asyncio.run(J.run_job(api.app.state.jobs, job_id, separator=api.app.state.separator,
                              transcribe=transcribe, build_result=api._build_result))
    c.run = run
    return c


def _wav_bytes(tmp_path):
    p = tmp_path / "song.wav"
    S.write_wav(str(p), np.zeros((2, S.SR), dtype=np.float32))
    return p.read_bytes()


def _wait(client, url):
    job_id = url.rsplit("/", 1)[-1]
    assert job_id in client.started
    client.run(job_id)
    return client.get(url).json()


@ffmpeg
def test_separate_job_end_to_end(client, tmp_path):
    from asr import api
    r = client.post("/v1/separate?language=es", content=_wav_bytes(tmp_path),
                    headers={"content-type": "audio/wav", "x-filename": "Song.wav"})
    assert r.status_code == 202, r.text
    j = r.json()
    assert j["status_url"] == f"/v1/jobs/{j['job_id']}" and j["download_url"].endswith("/download")
    done = _wait(client, j["status_url"])
    assert done["status"] == "done", done
    assert done["result"]["words"][0]["word"] == "Hola" and done["model"] == "htdemucs"
    d = client.get(j["download_url"])
    assert d.status_code == 200 and "Song-karaoke.mp3" in d.headers["content-disposition"]
    assert not list(api.app.state.jobs.dir(j["job_id"]).glob("*.wav"))   # stems cleaned up
    assert client.delete(j["status_url"]).status_code == 200
    assert client.get(j["status_url"]).status_code == 404


def test_listen_without_separate_never_starts_a_job(client):
    from asr import api
    r = client.post("/v1/listen", content=b"x")
    assert r.status_code == 200 and "separate" not in r.json()["metadata"]
    assert client.started == [] and api.app.state.jobs.ids() == []


@ffmpeg
def test_listen_separate_vocals_returns_transcript_and_job(client, tmp_path):
    r = client.post("/v1/listen?separate=vocals", content=_wav_bytes(tmp_path))
    assert r.status_code == 200
    body = r.json()
    assert body["results"]["channels"][0]["alternatives"][0]["transcript"] == "Hola amor."
    sep = body["metadata"]["separate"]
    assert _wait(client, sep["status_url"])["status"] == "done"


def test_listen_separate_bad_value_400(client):
    assert client.post("/v1/listen?separate=drums", content=b"x").status_code == 400


def test_job_errors(client):
    from asr import api
    r = client.get("/v1/jobs/" + "0" * 32)
    assert r.status_code == 404 and set(r.json()) == {"err_code", "err_msg", "request_id"}
    assert client.get("/v1/jobs/nope").status_code == 404
    assert client.post("/v1/separate", content=b"").status_code == 400
    st = api.app.state.jobs
    i = st.new_id()
    st.create(i, filename="a", language="auto", request_id="r")
    r = client.get(f"/v1/jobs/{i}/download")
    assert r.status_code == 409 and r.json()["err_code"] == "JOB_NOT_READY"


def test_busy_returns_503(client, monkeypatch):
    from asr import api
    monkeypatch.setattr(J, "MAX_ACTIVE", 0)
    r = client.post("/v1/separate", content=b"x")
    assert r.status_code == 503 and r.json()["err_code"] == "SERVER_BUSY" and r.headers["retry-after"]
    r = client.post("/v1/listen?separate=vocals", content=b"x")   # transcript still delivered
    assert r.status_code == 200 and r.json()["metadata"]["separate"]["status"] == "rejected"
