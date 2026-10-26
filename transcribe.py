"""CLI client: send audio to the running service instead of loading a model.

Only the server touches the GPU, so the CLI can run anywhere (even your Mac)
and never causes CUDA OOM. Use transcribe_local.py for offline use.
"""
import argparse
import os
import sys

import httpx

DEFAULT_URL = os.environ.get("ASR_URL", "http://localhost:8000")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--url", default=DEFAULT_URL)
    args = ap.parse_args()
    with httpx.Client(base_url=args.url, timeout=600) as client:
        for f in args.files:
            with open(os.path.expanduser(f), "rb") as fh:
                r = client.post("/v1/listen", params={"utterances": "true"},
                                content=fh.read(), headers={"Content-Type": "audio/*"})
            print(f"== {f}", flush=True)
            if r.status_code != 200:
                err = r.json()
                print(f"error {r.status_code}: {err['err_code']} {err['err_msg']}", file=sys.stderr)
                continue
            for u in r.json()["results"]["utterances"]:
                s = int(u["start"])
                print(f"[{s // 60:02d}:{s % 60:02d}] {u['transcript']}", flush=True)


if __name__ == "__main__":
    main()
