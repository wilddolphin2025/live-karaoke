"""CLI: transcribe audio files with the shared engine."""
import os
import sys

import soundfile as sf

from asr.engine import ParakeetEngine, to_mono_16k


def main(paths: list[str]) -> None:
    engine = ParakeetEngine()
    for f in paths:
        audio, sr = sf.read(os.path.expanduser(f), dtype="float32")
        print(f"== {f}", flush=True)
        for seg in engine.transcribe(to_mono_16k(audio, sr)):
            s = int(seg.start)
            print(f"[{s // 60:02d}:{s % 60:02d}] {seg.text}", flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
