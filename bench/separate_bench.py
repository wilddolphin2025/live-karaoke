"""Measure Demucs peak VRAM / RAM / time on one file.  Usage (inside the service image):
  python bench/separate_bench.py song.ogg [model] [cuda|cpu] [vram_cap_fraction]"""
import resource, sys, threading, subprocess, time
import torch
from asr.separate import load_stereo, separate, write_wav, SR

path = sys.argv[1]; model = sys.argv[2] if len(sys.argv) > 2 else "htdemucs"
dev = sys.argv[3] if len(sys.argv) > 3 else "cuda"
if dev == "cuda" and len(sys.argv) > 4:
    torch.cuda.set_per_process_memory_fraction(float(sys.argv[4]))
peak_smi = [0]
def poll():
    while not done:
        try:
            u = int(subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                                   capture_output=True, text=True).stdout.split()[0]); peak_smi[0] = max(peak_smi[0], u)
        except Exception: pass
        time.sleep(0.2)
done = False
base = int(subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], capture_output=True, text=True).stdout.split()[0])
threading.Thread(target=poll, daemon=True).start()
mix = load_stereo(path)
t = time.time()
st = separate(mix, model, dev, progress=lambda p: print(f"  {p:.0%}", flush=True))
done = True
write_wav("/out/vocals.wav", st.vocals); write_wav("/out/instrumental.wav", st.instrumental)
print(f"model={model} device={st.device} audio={mix.shape[1]/SR:.1f}s time={time.time()-t:.1f}s "
      f"peak_alloc={torch.cuda.max_memory_allocated()/2**20 if dev=='cuda' else 0:.0f}MiB "
      f"peak_reserved={torch.cuda.max_memory_reserved()/2**20 if dev=='cuda' else 0:.0f}MiB "
      f"gpu_used_delta={peak_smi[0]-base}MiB maxrss={resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024:.0f}MiB")
