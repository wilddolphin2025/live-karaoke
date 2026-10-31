# Live Karaoke

Live Karaoke turns any song or video into sing-along karaoke on your own hardware: a timed transcript of the singer's words, an instrumental track and an optional translation. Its backend is the **Parakeet ASR service**, a local, private, **Deepgram-compatible speech-to-text service**. Nothing leaves the box.

- **ASR:** `nvidia/nemotron-labs-unified-asr-0.6b` on NeMo (bf16, word timestamps, language prompt).
- **Translation (optional):** `google/translategemma-4b-it` (Q4_K_M GGUF), served by llama.cpp and started on demand.
- **Vocal removal / karaoke (optional):** Demucs (`htdemucs_ft` on GPU, `htdemucs` on CPU), run as on-demand jobs.
- **Runtime:** k3s on one 4 GB RTX 3050 laptop GPU, time-sliced into 2 slots.
- **Clients:** a Chrome extension ([extension/](extension/README.md)) and an iOS app ([ios/](ios/README.md)).

Docs: **[BUILD.md](BUILD.md)** (build everything from scratch) · **[ARCHITECTURE.md](ARCHITECTURE.md)** (internals, for forkers).

## Current state (service 0.7.0, extension 0.6.3)

| component | version | status |
|---|---|---|
| Service (`asr/`, `GET /v1/info` → `service_version`) | **0.7.0** | deployed on a single k3s GPU host; NeMo 3.0.0, torch 2.11.0+cu128 |
| Chrome extension "Live Karaoke" (`extension/package.json`) | **0.6.3** | in daily use; unit tests and mock/live e2e |
| iOS app "Live Karaoke" (`ios/project.yml`) | **1.0.0** (build 1), iOS 17+ | first version; runs on simulator and device |

### Features
- `POST /v1/listen`: Deepgram request/response shape, with `language`, `utterances`, `paragraphs`, word timings, `detected_language` and an ffmpeg fallback for video and container formats (mp4/mov/mkv/webm/m4a).
- Private translation, either `translate=` on `/v1/listen` (Deepgram name) or progressively, sentence by sentence, via `POST /v1/translate`. The cluster switches to translate mode on demand and back after 10 idle minutes.
- Opt-in vocal removal jobs (`POST /v1/separate`, `/v1/jobs/*`): a karaoke video or mp3, plus a timed transcript of the singer's vocals.
- `GET /v1/info`: versions, model, GPU, pod, translation and separation state. The `x-served-by` header names the pod.
- Extension: drag-and-drop transcription, playback with word highlighting, translation pane, karaoke swap in place, side panel.
- iOS app: a library of karaoke bundles (Files or URL import), karaoke/original toggle, timed translation, and deep links.

### Privacy (iOS app)
The public app sends audio only to the server you configure. Optional add-on builds (see BUILD.md,
`LK_PREMIUM`) may look up official lyrics on [LRCLIB](https://lrclib.net) when online, sending only the
song title, artist and duration (never audio), and may record your voice locally when you tap Record
(microphone permission; recordings stay on the device and appear in the Files app).

### Known limitations / unverified
- **iOS:** on the test clip, the karaoke video shows a **black frame** (audio plays). Not yet diagnosed.
- **iOS:** the **Files picker** import path is untested. URL import and deep links were tested.
- **Demucs falls back to CPU** whenever less than 900 MiB VRAM is free, which is normal while ASR pods or the translator are resident. Then a 160 s song takes about 50 s instead of 14 s (`htdemucs`) or 50 s (`htdemucs_ft`, GPU).
- Translate mode halves ASR throughput (1 ASR pod) and is slower and of lower quality than cloud translation.
- Host paths, server IP/hostname, TLS secret and Apple team ID are not committed: set them in `deploy/local.env`, `extension/local.env` and `ios/Local.xcconfig`. See [Configure for your setup](BUILD.md#configure-for-your-setup).
- x86_64 + CUDA only for now. For ARM see [ARCHITECTURE.md → Porting](ARCHITECTURE.md#porting-arm--non-cuda).

## Quick start

On an Ubuntu host with an NVIDIA GPU (details in [BUILD.md](BUILD.md)):

```bash
git clone https://github.com/wilddolphin2025/live-karaoke ~/parakeet && cd ~/parakeet
sudo deploy/install.sh          # NVIDIA Container Toolkit + k3s with the nvidia runtime
deploy/deploy.sh                # build image, import into k3s, apply manifests (uses sudo)
curl -s http://localhost:30800/v1/info
curl -s -X POST --data-binary @speech.wav 'http://localhost:30800/v1/listen?language=auto&utterances=true'
```

Extension: `make extension`, then load `extension/dist` unpacked in `chrome://extensions`.
iOS: `cd ios && xcodegen && open ParakeetKaraoke.xcodeproj`.

## API

| endpoint | Deepgram? | purpose |
|---|---|---|
| `POST /v1/listen` | yes | transcribe a raw audio/video body |
| `POST /v1/translate` | no (addition) | translate timed sentences |
| `POST /v1/separate` | no (addition) | start a vocal-removal job (202) |
| `GET /v1/jobs/{id}`, `GET /v1/jobs/{id}/download`, `DELETE /v1/jobs/{id}` | no (addition) | poll, download, cancel/delete |
| `GET /v1/info` | no | versions and modes |
| `GET /healthz`, `/readyz`, `/docs` | – | probes, OpenAPI UI |

`/v1/listen` query parameters: `language` (`auto` or an ISO code), `utterances`, `paragraphs`, `translate`,
`separate=vocals`, and `model` (accepted and ignored). Errors use the Deepgram style:
`{"err_code", "err_msg", "request_id"}`.

### Translation
`POST /v1/listen?language=ru&translate=en` returns
`results.channels[0].alternatives[0].translations = [{"language": "en", "translation": "..."}]`, with the same parameter and
field names as Deepgram. The source language comes from `language` (or detection).

**Extensions beyond Deepgram:**
- `translate=en,de` takes comma-separated targets (max 2) and returns one `translations` entry each.
- `results.utterances[].translations` holds per-utterance translations (with `utterances=true`). The full translation is
  the per-utterance/segment translations joined.
- While the cluster switches modes, the API returns `503` with `Retry-After` and a Deepgram-style body `{"err_code": "TRANSLATOR_WARMING_UP", "err_msg": ..., "request_id": ...}`
  (`TRANSLATOR_UNAVAILABLE` if the switch fails). Clients should retry.
- An unknown target returns `400 {"err_code": "INVALID_QUERY_PARAMETER", ...}`.
- `paragraphs=true` returns Deepgram's `alternatives[].paragraphs = {transcript, paragraphs: [{sentences: [{text, start, end}], start, end, num_words}]}`.
- With `language=auto`, `results.channels[0].detected_language` is filled in from the transcript.
- `metadata.models` also lists the translator model when translation ran.

Language codes: all 581 of TranslateGemma's template are accepted (`pt-BR`, `zh-TW`, `sr-Latn`, …; case- and `_`-insensitive).
`/v1/info` lists the 55 evaluated (WMT24++) languages.

### `POST /v1/translate` (addition, for progressive clients)
Clients call plain `/v1/listen?paragraphs=true` first (no `translate=`, so the transcript is not delayed), then send the
timed sentences here a few at a time. `start`/`end` are echoed back, so playback stays in sync.

```
POST /v1/translate  {"target": "en", "source": "ru" | "auto" | null,
                     "sentences": [{"text": "Привет.", "start": 0.5, "end": 1.4}]}      (max 64 sentences)
200 {"request_id": "...", "model": "...", "language": "en", "source": "ru",
     "sentences": [{"text": "Привет.", "start": 0.5, "end": 1.4, "translation": "Hello."}]}
```
An empty `sentences` list only warms up the translator (it triggers the mode switch). The same 503/400 rules apply as for `/v1/listen?translate=`.

### Vocal removal (addition; strictly opt-in)
The server never runs Demucs unless a request explicitly asks for it. Plain `/v1/listen` and `/v1/translate` are unchanged,
and separation runs in the background after the transcript is returned.

```
POST /v1/separate?language=auto      raw audio/video body, optional X-Filename (percent-encoded ok), max 200 MB
202 {"request_id", "job_id", "status": "queued", "status_url": "/v1/jobs/<id>", "download_url": "/v1/jobs/<id>/download"}

GET  /v1/jobs/<id>      200 {job_id, status: queued|separating|transcribing|muxing|done|failed|cancelled, stage,
                             progress 0..1, created, updated, expires_at, filename, language, device, model, is_video,
                             size, timings, error?, result? (done: {transcript, words[], utterances[]} of the vocals stem),
                             status_url, download_url}
GET  /v1/jobs/<id>/download   the karaoke file (Content-Disposition: attachment; <stem>-karaoke.<ext>, Range ok)
DELETE /v1/jobs/<id>    cancels a running job and deletes its files

POST /v1/listen?...&separate=vocals   normal Deepgram response; the job is started afterwards and announced in
                                      metadata.separate = {job_id, status, status_url, download_url}
                                      (or {status: "rejected", error}; the transcript is still returned).
```
Output: video input becomes `<name>-karaoke.<ext>` (video stream copied bit-exact with instrumental audio), and audio input becomes `<name>-karaoke.mp3`.
Errors: `404 NOT_FOUND`, `409 JOB_NOT_READY`, `503 SERVER_BUSY` + `Retry-After` (`JOBS_MAX_ACTIVE` running),
`503 INSUFFICIENT_STORAGE`, `413 PAYLOAD_TOO_LARGE`, `400` (empty body). A failed job has
`error: {err_code: SEPARATOR_UNAVAILABLE | SEPARATOR_ERROR | JOB_LOST | ..., err_msg}`.

### Deviations from Deepgram (summary)
- **Additions:** `/v1/translate`, `/v1/separate`, `/v1/jobs/*`, `/v1/info`; the query parameter `separate=`; the response fields `metadata.separate` and `results.utterances[].translations`; multiple `translate=` targets.
- **503 + `Retry-After`** with `TRANSLATOR_WARMING_UP`, `SERVER_BUSY`, `GPU_OUT_OF_MEMORY`, `INSUFFICIENT_STORAGE`.
- Async work is **polled** (`/v1/jobs`), not delivered by Deepgram's callbacks.
- `model=` is accepted but ignored (there is one ASR model). Only pre-recorded audio is supported; there is no streaming websocket.

## Repository layout
```
asr/            service: api.py (FastAPI), engine.py (NeMo), translate.py (translator client + ModeController),
                jobs.py / separate.py / separator_api.py (vocal removal), sentences.py, audio.py, schemas.py
deploy/         install.sh (host), deploy.sh (build + deploy), k8s/*.yaml, render.sh, make-cert.sh, local.env.example (tls/ is gitignored)
extension/      Chrome MV3 extension (TypeScript, esbuild)
ios/            SwiftUI app (xcodegen project.yml)
tests/          pytest (unit + `accuracy`-marked live tests)   bench/  WER and separation benchmarks
transcribe*, serve   legacy CLI / bare-metal helpers
```
