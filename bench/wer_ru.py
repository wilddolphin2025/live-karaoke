"""WER on FLEURS ru_ru test via the running API. Usage: wer_ru.py URL N [language]"""
import csv, re, sys, time, concurrent.futures as cf
import httpx

sys.path.insert(0, '.')
from asr.wer import wer

url, n = sys.argv[1], int(sys.argv[2])
lang = sys.argv[3] if len(sys.argv) > 3 else None
rows = list(csv.reader(open("testdata/ru/test.tsv"), delimiter="\t"))[:n]


def run(row):
    fname, ref = row[1], row[2]
    data = open(f"testdata/ru/test/{fname}", "rb").read()
    params = {"language": lang} if lang else {}
    r = httpx.post(f"{url}/v1/listen", params=params, content=data,
                   headers={"Content-Type": "audio/wav"}, timeout=120)
    hyp = r.json()["results"]["channels"][0]["alternatives"][0]["transcript"]
    return ref, hyp

t = time.time()
with cf.ThreadPoolExecutor(4) as ex:
    pairs = list(ex.map(run, rows))
print(f"clips={len(pairs)} WER={100*wer(pairs):.2f}% wall={time.time()-t:.1f}s")
for r, h in pairs[:3]:
    print("REF:", r[:120]); print("HYP:", h[:120])
