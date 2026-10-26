"""CLI: transcribe audio files with the shared engine."""
import os
import sys

import soundfile as sf
import torch

from asr.engine import ParakeetEngine, to_mono_16k


def main(paths: list[str]) -> None:
    try:
        engine = ParakeetEngine()
    except torch.OutOfMemoryError:
        free, total = torch.cuda.mem_get_info()
        sys.exit(f"GPU busy: only {free >> 20} of {total >> 20} MiB free. "
                 "Check other GPU processes with `nvidia-smi` (is the server running?).")
    for f in paths:
        audio, sr = sf.read(os.path.expanduser(f), dtype="float32")
        print(f"== {f}", flush=True)
        for seg in engine.transcribe(to_mono_16k(audio, sr)):
            s = int(seg.start)
            print(f"[{s // 60:02d}:{s % 60:02d}] {seg.text}", flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
