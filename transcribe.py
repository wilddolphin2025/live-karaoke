import sys, os, logging, tempfile, torch, numpy as np, soundfile as sf
logging.disable(logging.WARNING)
from nemo.utils import logging as nlog; nlog.setLevel(logging.ERROR)
import nemo.collections.asr as a
CH = 60  # seconds per chunk
m = a.models.ASRModel.from_pretrained("nvidia/parakeet-tdt-0.6b-v3", map_location="cpu").eval().to(torch.bfloat16).cuda()
tmp = tempfile.mkdtemp()
for f in sys.argv[1:]:
    audio, sr = sf.read(os.path.abspath(os.path.expanduser(f)), dtype="float32")
    if audio.ndim > 1: audio = audio.mean(1)
    if sr != 16000:
        import torchaudio.functional as F
        audio = F.resample(torch.from_numpy(audio), sr, 16000).numpy(); sr = 16000
    print(f"== {f}", flush=True)
    for i in range(0, len(audio), CH*sr):
        p = os.path.join(tmp, "c.wav"); sf.write(p, audio[i:i+CH*sr], sr)
        with torch.inference_mode():
            t = m.transcribe([p], verbose=False)[0].text
        s = i//sr; print(f"[{s//60:02d}:{s%60:02d}] {t}", flush=True)
