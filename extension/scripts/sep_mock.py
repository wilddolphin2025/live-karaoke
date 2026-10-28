"""Mock server for scripts/sep_e2e.mjs: canned /v1/listen, a /v1/separate job done after 3 s, download = the input
file itself (stands in for the karaoke file), DELETE logged. Usage: python3 sep_mock.py [port]"""
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
JOB = {}
W = [{"word": w, "punctuated_word": w, "start": i * 0.5, "end": i * 0.5 + 0.4, "confidence": 1} for i, w in enumerate("me lo dijo amela que tu ya no me quieres".split())]
class H(BaseHTTPRequestHandler):
    def _j(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        print(f"POST {self.path} xfn={self.headers.get('x-filename')}", flush=True)
        if self.path.startswith("/v1/listen"):
            return self._j(200, {"metadata": {"request_id": "r1", "duration": 5, "models": ["mock"]}, "results": {"channels": [{"alternatives": [{"transcript": " ".join(w["word"] for w in W), "words": W}]}],
                "utterances": [{"start": 0, "end": 5, "transcript": " ".join(w["word"] for w in W)}]}})
        if self.path.startswith("/v1/separate"):
            JOB.update(deleted=False, t0=time.time(), body=body, type=self.headers.get("content-type"), video=self.headers.get("content-type", "").startswith("video/"))
            return self._j(202, {"request_id": "r2", "job_id": "j1", "status": "queued", "status_url": "/v1/jobs/j1", "download_url": "/v1/jobs/j1/download"})
        self._j(404, {"err_code": "NOT_FOUND"})
    def do_GET(self):
        if self.path == "/v1/jobs/j1" and JOB.get("deleted"): return self._j(404, {"err_code": "NOT_FOUND"})
        if self.path == "/v1/jobs/j1":
            dt = time.time() - JOB["t0"]
            if dt < 6: return self._j(200, {"job_id": "j1", "status": "separating", "progress": dt / 7, "device": "cuda", "model": "htdemucs_ft"})
            return self._j(200, {"job_id": "j1", "status": "done", "progress": 1, "device": "cuda", "model": "htdemucs_ft", "is_video": JOB["video"],
                                 "download_url": "/v1/jobs/j1/download", "result": {"words": W[::2], "utterances": []}})
        if self.path == "/v1/jobs/j1/download":
            b = JOB["body"]; n = len(b); rng = self.headers.get("range")  # Range like the real FileResponse (seekable media)
            if rng and rng.startswith("bytes="):
                lo, _, hi = rng[6:].partition("-"); lo = int(lo or 0); hi = min(int(hi) if hi else n - 1, n - 1)
                self.send_response(206); self.send_header("Content-Range", f"bytes {lo}-{hi}/{n}"); b = b[lo:hi + 1]
            else: self.send_response(200)
            self.send_header("Accept-Ranges", "bytes"); self.send_header("Content-Type", JOB["type"])
            self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b); return
        self._j(404, {"err_code": "NOT_FOUND"})
    def do_DELETE(self):
        print(f"DELETE {self.path}", flush=True); JOB["deleted"] = True; self._j(200, {"deleted": True})
ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1]) if len(sys.argv) > 1 else 18998), H).serve_forever()
