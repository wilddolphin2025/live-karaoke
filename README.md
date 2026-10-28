# parakeet-asr

Self-hosted, Deepgram-compatible speech-to-text (`POST /v1/listen`) on k3s with a time-sliced RTX 3050 (2 GPU slots),
plus optional **private, on-box translation** with `google/translategemma-4b-it` (GGUF Q4_K_M via llama.cpp).
Browser extension: [extension/README.md](extension/README.md).

## Translation

### Modes
| mode | pods | notes |
|---|---|---|
| `asr` (default) | `parakeet-asr` ×2 | full ASR throughput |
| `translate` | `parakeet-asr` ×1 + `translator` ×1 | the translator takes the freed GPU slot (~1.75 GB VRAM, `--n-gpu-layers 18` of 34) |

The first request with `translate=` switches the cluster to translate mode: the receiving ASR pod sets its own
`controller.kubernetes.io/pod-deletion-cost=1000` (so the scale-down removes the *other* pod, not the one serving the
request), scales `parakeet-asr` to 1, then `translator` to 1. Until the translator answers `/health` (~30–60 s)
the API returns **503 + `Retry-After: 15`**. Every translate request stamps `parakeet.io/translate-last-used` on the
translator deployment; after `TRANSLATE_IDLE_MINUTES` (10) with no translate requests, an ASR pod scales the
translator to 0 and ASR back to `ASR_REPLICAS` (2). Permissions: `deploy/k8s/rbac.yaml` (get/patch on just these two
deployments + their scale, patch pods).

Model (since 0.6.0): `google/translategemma-4b-it`, Q4_K_M GGUF from `mradermacher/translategemma-4b-it-GGUF`
(Gemma license). The server sends a raw `/completion` prompt identical to the model's chat template
(`<start_of_turn>user\nYou are a professional Spanish (es) to Russian (ru) translator. …<end_of_turn>\n<start_of_turn>model\n`,
stop `<end_of_turn>`), so llama.cpp runs without `--jinja`. Codes: all 581 of the template (`pt-BR`, `zh-TW`, `sr-Latn`, …;
case/`_` insensitive); `/v1/info` lists the 55 evaluated (WMT24++) languages. Riva-Translate-4B (≤0.5.x) was removed;
roll back via git if ever needed.

Measured (RTX 3050 4 GB, one ASR pod resident): GPU 1.67 + 1.75 GB, ~0.3–0.5 s for a short line, ~1 s for a
typical sentence, ~2–2.5 s for a 40-word run-on. Translate mode is private but slower and lower quality than a
cloud translator; ASR throughput is halved while it is active.

### API (Deepgram-compatible)
`POST /v1/listen?language=ru&translate=en` →
`results.channels[0].alternatives[0].translations = [{"language": "en", "translation": "..."}]` — same parameter and
field names as Deepgram. Source language comes from `language` (or detection).

**Extensions beyond Deepgram:**
- `translate=en,de` — comma-separated targets (max 2), one `translations` entry each.
- `results.utterances[].translations` — per-utterance translations (with `utterances=true`); the full translation is
  the per-utterance/segment translations joined.
- `503` with `Retry-After` and Deepgram-style body `{"err_code": "TRANSLATOR_WARMING_UP", "err_msg": ..., "request_id": ...}`
  while the cluster switches modes (`TRANSLATOR_UNAVAILABLE` if it fails). Clients should retry.
- Unknown target → `400 {"err_code": "INVALID_QUERY_PARAMETER", ...}`.
- `paragraphs=true` — Deepgram's `alternatives[].paragraphs = {transcript, paragraphs: [{sentences: [{text, start, end}], start, end, num_words}]}`.
  Sentences are split on terminal punctuation (or a >1.5 s pause / 40 words) and timed from word timestamps.

### `POST /v1/translate` (extension, not part of Deepgram)
For progressive clients (the Chrome extension): call plain `/v1/listen?paragraphs=true` first (no `translate=`, so the
transcript is not delayed), then send the timed sentences here one or a few at a time; start/end are echoed back so the
client can sync the translation with playback.

```
POST /v1/translate  {"target": "en", "source": "ru" | "auto" | null,
                     "sentences": [{"text": "Привет.", "start": 0.5, "end": 1.4}]}      (max 64 sentences)
200 {"request_id": "...", "model": "...", "language": "en", "source": "ru",
     "sentences": [{"text": "Привет.", "start": 0.5, "end": 1.4, "translation": "Hello."}]}
```
An empty `sentences` list only warms up (triggers the mode switch). Same 503 + `Retry-After` / `TRANSLATOR_WARMING_UP`
and 400 rules as `/v1/listen?translate=`. `/v1/listen?translate=` keeps working unchanged for Deepgram clients.
- `GET /v1/info` has a `translation` block: `model`, `languages`, and `mode` (`asr` | `warming` | `translate` | `unmanaged`).
- `metadata.models` additionally lists the translator model when translation ran.

Env: `TRANSLATOR_URL` (http://translator:8080), `TRANSLATOR_DEPLOYMENT` (translator), `TRANSLATE_IDLE_MINUTES` (10), `ASR_REPLICAS` (2),
`TRANSLATE_WAIT_S` (20, how long a request waits for a warming translator before 503).

## Vocal removal / karaoke (service 0.7.0, extension 0.6.0)

**Strictly opt-in.** The server never runs Demucs unless a request explicitly asks for it (`POST /v1/separate`
or `/v1/listen?separate=vocals`). Plain `/v1/listen` and `/v1/translate` are unchanged, and the transcript and
translation are never delayed: separation is post-processing that runs after them, in the background.

Pipeline per job: decode → **Demucs** (vocals / instrumental) → ASR on the **vocals stem** (words with timestamps;
the "singer transcript") → output:
- video input → `<name>-karaoke.<ext>`: the video stream copied bit-exact (`-c:v copy`) + instrumental audio;
- audio input → `<name>-karaoke.mp3`: the instrumental.

### API (extension, not part of Deepgram)
```
POST /v1/separate?language=auto      raw audio/video body, optional X-Filename (percent-encoded ok), max 200 MB
202 {"request_id", "job_id", "status": "queued", "status_url": "/v1/jobs/<id>", "download_url": "/v1/jobs/<id>/download"}

GET  /v1/jobs/<id>      200 {job_id, status: queued|separating|transcribing|muxing|done|failed|cancelled, stage,
                             progress 0..1, created, updated, expires_at, filename, language, device, model, is_video,
                             size, timings, error?, result? (done: {transcript, words[], utterances[]} of the vocals stem),
                             status_url, download_url}
GET  /v1/jobs/<id>/download   the karaoke file (Content-Disposition: attachment; <stem>-karaoke.<ext>, Range ok)
DELETE /v1/jobs/<id>    cancels a running job and deletes its files

POST /v1/listen?...&separate=vocals   normal Deepgram response, delivered as usual; the job is started afterwards
                                      and announced in metadata.separate = {job_id, status, status_url, download_url}
                                      (or {status: "rejected", error} if it could not be queued; the transcript is still returned).
```
Errors are Deepgram-style `{"err_code", "err_msg", "request_id"}`: `404 NOT_FOUND` (unknown/expired/deleted job),
`409 JOB_NOT_READY` (download before done), `503 SERVER_BUSY` + `Retry-After` (JOBS_MAX_ACTIVE jobs running),
`503 INSUFFICIENT_STORAGE` (free disk < JOBS_MIN_FREE_GB), `413 PAYLOAD_TOO_LARGE`, `400` for an empty body.
A failed job reports `status: failed` with `error: {err_code: SEPARATOR_UNAVAILABLE | SEPARATOR_ERROR | JOB_LOST | ..., err_msg}`.

**Deviations from Deepgram** (Deepgram has no source separation): `/v1/separate`, `/v1/jobs/*`, the `separate=`
query parameter and `metadata.separate` are all additions; Deepgram's async model is callbacks, this is polling.
Job files (input, stems, output) live in a hostPath shared by the ASR pods and the separator
(`~/.cache/parakeet-jobs`) and are deleted after `JOB_TTL_MINUTES` (60) or on DELETE; jobs with no heartbeat for
`JOB_STALE_S` are marked `JOB_LOST`.

### Separator Deployment (on demand, scales to 0)
`deploy/k8s/separator.yaml`: Deployment `separator` (replicas 0) running `asr.separator_api` from the same
`parakeet-asr:dev` image (+ ~3 MB demucs layer; no new image). The ModeController scales it to 1 when a job arrives and
back to 0 after `SEPARATOR_IDLE_MINUTES` (5) idle. It takes **no GPU time-slice**: it sees the GPU via
`runtimeClass nvidia` and uses CUDA only when ≥ `SEPARATOR_MIN_FREE_VRAM_MB` (900) is free, else CPU; a CUDA OOM retries
on CPU. One job at a time; memory request 2 Gi / limit 5 Gi. Weights (402 MB, `htdemucs_ft` + `htdemucs`) are in
`~/.cache/huggingface/torch`, offline.

Chunked inference: 30 s chunks with 1 s linear crossfade (`SEPARATOR_CHUNK_S`, `SEPARATOR_OVERLAP_S`), Demucs
segment 7.8 s, so memory is bounded regardless of song length.

Measured (160 s song, RTX 3050 4 GB):

| model | device | time | peak VRAM (alloc / reserved / nvidia-smi Δ) | max RSS |
|---|---|---|---|---|
| htdemucs_ft (GPU default) | cuda | 50.6 s | 544 / 688 / ~797 MiB | 2.6 GiB |
| htdemucs | cuda | 14 s | 544 / 688 / 797 MiB | 1.9 GiB |
| htdemucs (CPU default) | cpu | 50.7 s | – | 1.7 GiB |

End to end in the separator container with the live ASR (GPU had ~800 MiB free, so CPU path): mp4 60.5 s total
(separate 56.2, vocals ASR 1.9, mux 2.2; 303 words; container peak 1.54 GiB, GPU untouched); ogg → mp3 57.9 s.

Env (ASR pods): `JOBS_DIR` (/jobs), `JOB_TTL_MINUTES` (60), `JOB_STALE_S` (600), `JOBS_MAX_ACTIVE` (3),
`JOBS_MIN_FREE_GB` (5), `SEPARATOR_URL` (http://separator:8001), `SEPARATOR_WAIT_S` (600),
`SEPARATOR_DEPLOYMENT` (separator), `SEPARATOR_IDLE_MINUTES` (5).
Env (separator): `SEPARATOR_MODEL` (htdemucs_ft), `SEPARATOR_CPU_MODEL` (htdemucs), `SEPARATOR_DEVICE` (auto|cuda|cpu),
`SEPARATOR_MIN_FREE_VRAM_MB` (900), `SEPARATOR_CHUNK_S` (30), `SEPARATOR_OVERLAP_S` (1), `SEPARATOR_SEGMENT_S` (7.8),
`TORCH_HOME` (/models/torch). `GET /v1/info` has a `separation` block.

## Deploy
`deploy/deploy.sh` (needs sudo for the image import). It applies gpu-sharing, rbac, translator (0 replicas), separator (0 replicas, scaled on demand;
a running one is restarted on the new code) and ASR,
and resets to `asr` mode (0.6.0: also deletes the old `riva-translate` Deployment/Service). The translator's
initContainer downloads the 2.5 GB GGUF into
`~/.cache/huggingface/gguf/` on first start if missing.

## Tests
`tests/test_separate.py`: chunking/crossfade, job store lifecycle/TTL, cancellation, output naming, mux packet equality, the job API with fakes. Extension: `npm test` (pure helpers), `scripts/e2e.mjs` (live, puppeteer), `scripts/sep_e2e.mjs` + `scripts/sep_mock.py` (Remove vocals flow against a mock server).
`pytest -m "not accuracy"`; `tests/test_translate.py` also has a live ru→en test (`ASR_URL=...`, marked `accuracy`).

### Translation quality notes (service 0.5.1+)
- With `language=auto` the server guesses the spoken language from the transcript (script + function words) and returns it as Deepgram `results.channels[0].detected_language`; the extension passes it as `source` to `/v1/translate` (and `/v1/translate` guesses too when `source` is `auto`). (Riva-Translate echoed Spanish with a generic "auto" prompt; TranslateGemma's template needs a source language — when none is known, a neutral "translator into X" wording is used.)
- Echo detection: output that is ≥80 % similar to the input, or not mostly in the target script, is retried with a stricter prompt (one extra sentence in TranslateGemma's instruction block: translate every word, never copy the source) and then clause by clause. Quotes the model wraps around a whole answer are stripped.
- Sentences break on terminal punctuation; a pause splits only if > 3 s and the sentence already has ≥ 8 words; run-ons break at 40 words, at the last comma when there is one.
