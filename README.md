# parakeet-asr

Self-hosted, Deepgram-compatible speech-to-text (`POST /v1/listen`) on k3s with a time-sliced RTX 3050 (2 GPU slots),
plus optional **private, on-box translation** with `nvidia/Riva-Translate-4B-Instruct-v2` (GGUF Q4_K_M via llama.cpp).
Browser extension: [extension/README.md](extension/README.md).

## Translation

### Modes
| mode | pods | notes |
|---|---|---|
| `asr` (default) | `parakeet-asr` ×2 | full ASR throughput |
| `translate` | `parakeet-asr` ×1 + `riva-translate` ×1 | the translator takes the freed GPU slot (~1.8 GB VRAM, `--n-gpu-layers 18`) |

The first request with `translate=` switches the cluster to translate mode: the receiving ASR pod sets its own
`controller.kubernetes.io/pod-deletion-cost=1000` (so the scale-down removes the *other* pod, not the one serving the
request), scales `parakeet-asr` to 1, then `riva-translate` to 1. Until the translator answers `/health` (~30–60 s)
the API returns **503 + `Retry-After: 15`**. Every translate request stamps `parakeet.io/translate-last-used` on the
translator deployment; after `TRANSLATE_IDLE_MINUTES` (10) with no translate requests, an ASR pod scales the
translator to 0 and ASR back to `ASR_REPLICAS` (2). Permissions: `deploy/k8s/rbac.yaml` (get/patch on just these two
deployments + their scale, patch pods).

Measured (RTX 3050 4 GB, one ASR pod resident): GPU 3.4/4.0 GB, ~24 tok/s generation, ~1–1.4 s per sentence,
~2 s end-to-end for a 7 s clip. Translate mode is private but slower and lower quality than a cloud translator;
ASR throughput is halved while it is active. Model license: NVIDIA Open Model License.

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

Env: `TRANSLATOR_URL` (http://riva-translate:8080), `TRANSLATE_IDLE_MINUTES` (10), `ASR_REPLICAS` (2),
`TRANSLATE_WAIT_S` (20, how long a request waits for a warming translator before 503).

## Deploy
`deploy/deploy.sh` (needs sudo for the image import). It applies gpu-sharing, rbac, translator (0 replicas) and ASR,
and resets to `asr` mode. The translator's initContainer downloads the 2.8 GB GGUF into
`~/.cache/huggingface/gguf/` on first start if missing.

## Tests
`pytest -m "not accuracy"`; `tests/test_translate.py` also has a live ru→en test (`ASR_URL=...`, marked `accuracy`).

### Translation quality notes (service 0.5.1)
- With `language=auto` the server guesses the spoken language from the transcript (script + function words) and returns it as Deepgram `results.channels[0].detected_language`; the extension passes it as `source` to `/v1/translate` (and `/v1/translate` guesses too when `source` is `auto`). Riva-Translate echoed Spanish back far more often with the generic "auto" prompt.
- Echo detection: output that is ≥80 % similar to the input, or not mostly in the target script, is retried with a stricter prompt and then clause by clause.
- Sentences break on terminal punctuation; a pause splits only if > 3 s and the sentence already has ≥ 8 words; run-ons break at 40 words, at the last comma when there is one.
