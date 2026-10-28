import json, time, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
T0 = {}; LOG = []
W = [{"word": w, "punctuated_word": w, "start": i*0.5, "end": i*0.5+0.4, "confidence": 1} for i, w in enumerate("me lo dijo amela".split())]
class H(BaseHTTPRequestHandler):
    def _j(self, code, obj, extra=()):
        b = json.dumps(obj).encode(); self.send_response(code)
        self.send_header("Content-Type", "application/json"); self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get("content-length", 0)); self.rfile.read(n)
        LOG.append(f"POST {self.path} xfn={self.headers.get('x-filename')}"); print(LOG[-1], flush=True)
        if self.path.startswith("/v1/listen"):
            return self._j(200, {"metadata": {"request_id": "r1", "duration": 2, "models": ["mock"]}, "results": {"channels": [{"alternatives": [{"transcript": "me lo dijo amela", "words": W}]}],
                "utterances": [{"start": 0, "end": 2, "transcript": "me lo dijo amela"}]}})
        if self.path.startswith("/v1/separate"):
            T0["j1"] = time.time()
            return self._j(202, {"request_id": "r2", "job_id": "j1", "status": "queued", "status_url": "/v1/jobs/j1", "download_url": "/v1/jobs/j1/download"})
        self._j(404, {"err_code": "NOT_FOUND"})
    def do_GET(self):
        if self.path == "/v1/jobs/j1":
            dt = time.time() - T0["j1"]
            if dt < 3: return self._j(200, {"job_id": "j1", "status": "separating", "progress": dt/4, "device": "cuda", "model": "htdemucs_ft"})
            return self._j(200, {"job_id": "j1", "status": "done", "progress": 1, "device": "cuda", "model": "htdemucs_ft", "is_video": False,
                                 "download_url": "/v1/jobs/j1/download", "result": {"words": W[:2], "utterances": []}})
        if self.path == "/v1/jobs/j1/download":
            b = open("/tmp/es_song.mp3", "rb").read(); self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b); return
        self._j(404, {"err_code": "NOT_FOUND"})
    def do_DELETE(self):
        LOG.append(f"DELETE {self.path}"); print(LOG[-1], flush=True); self._j(200, {"deleted": True})
ThreadingHTTPServer(("0.0.0.0", 18998), H).serve_forever()
