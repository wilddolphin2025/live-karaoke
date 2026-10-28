# Parakeet ASR Chrome extension (Manifest V3)

Drag-and-drop audio transcription window for the Parakeet ASR service (Deepgram-compatible `POST /v1/listen`).

## Build and package

Requires Node 18+ (and `tar`, `zip`).

```bash
# from the repo root: npm ci + build + package
make extension

# or manually
cd extension
npm ci
npm run build      # typecheck + esbuild bundle + generated icons -> dist/
npm run package    # build, then archive dist/ -> release/
```

Outputs (gitignored):

- `dist/`: the unpacked extension (`manifest.json`, `background.js`, `app.html/js/css`, `icons/`)
- `release/parakeet-extension-<version>.tar.gz`: extracts to a `parakeet-extension/` folder
- `release/parakeet-extension-<version>.zip`: `manifest.json` at the root (Chrome Web Store upload format)

## Install on another machine (e.g. your Mac)

```bash
scp slim:~/parakeet/extension/release/parakeet-extension-0.5.0.tar.gz ~/
mkdir -p ~/parakeet-ext && tar -xzf ~/parakeet-extension-0.5.0.tar.gz -C ~/parakeet-ext
# -> ~/parakeet-ext/parakeet-extension/manifest.json
```

You can also copy the folder directly: `scp -r slim:~/parakeet/extension/dist ~/parakeet-ext/parakeet-extension`.

Then in Chrome:

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select `~/parakeet-ext/parakeet-extension`.
3. Pin "Parakeet ASR" and click the icon. A popup (800x600, the Chrome maximum) drops down from the icon. Drop an audio file (wav/mp3/flac/ogg/m4a/webm) or a video (mp4/mov/mkv/webm) on it or click to pick one.
4. Optional: click 📌 to move the UI into Chrome's side panel, which stays open on the right while you browse.

To update: rebuild, re-extract over the same folder, then click the reload button on the extension card.

## How it works

- **Background upload:** a popup closes whenever it loses focus. So the audio is saved to IndexedDB and the background service worker does the upload. The last status and result are kept in `chrome.storage.session`. Reopen the popup and it restores the transcript and the player. Closing a popup in the middle of an upload doesn't cancel it.
- **Video files:** the server decodes with soundfile first. If that fails (mp4, mov, mkv, webm, m4a/AAC and other containers), it falls back to ffmpeg, which pulls out the audio track (`-vn -ac 1 -ar 16000 -f f32le`). Video files play in a `<video>` element and audio files in `<audio>`, so the highlighting follows whichever one is playing. If ffmpeg can't decode the file either, the server returns `UNSUPPORTED_AUDIO`.
- **Player and highlighting:** the dropped file plays in a player. The transcript is shown as words. The word being spoken is highlighted and scrolled into view, and clicking a word jumps to it. This uses `results.channels[0].alternatives[0].words[]`. If no word timings come back (an older server), it highlights whole utterances instead.
- **Versions footer:** shows the extension version, plus `GET /v1/info` (service version and git SHA, model, NeMo and torch versions, pod, GPU). The meta line shows which pod handled each transcription, from the `x-served-by` header.

## Settings

Open them with the ⚙ gear in the top bar; **← Back** (or Esc) returns to the main view. The main view has only the
drop zone (shrinks to one line once a file is loaded), a chip showing the language and translation target, a compact status
line with Copy/Download, the player, and the transcript and translation panes, which fill the rest and scroll independently
(side by side in the popup and in a wide side panel, stacked in a narrow one). Everything below is in Settings, along with
details of the last file and the version info (Extension, Service, Model, NeMo, torch, Pod, GPU, Mode).

- **Server**: default `http://192.168.8.226:30800` (NodePort). `https://slim` (Traefik) also works. Any other URL triggers a one-time Chrome permission prompt (`optional_host_permissions`).
- **Spoken language**: `auto` or a language code.
- **Translate to** + target language.
- **Remove vocals (karaoke)**: off by default; see below.

All are saved in `chrome.storage.local`.

## Self-signed cert (https://slim)

Chrome rejects the self-signed certificate until you trust it. Open `https://slim/` in a tab once and accept the warning (Advanced, then Proceed), or add the cert to your system keychain as trusted. Until then you get a "Network error". The machine also has to resolve `slim` (for example via /etc/hosts). The default `http://192.168.8.226:30800` avoids all of this.

## CORS

None needed. The request comes from the extension page, and `host_permissions` exempt it from CORS. The server is unchanged.

## Translation (0.5.0)

Tick **Translate to** and pick a language. The transcript appears as soon as ASR finishes (plain
`/v1/listen?paragraphs=true`); a second **translation pane** (below the transcript; side by side in a wide side panel)
then fills sentence by sentence via `POST /v1/translate`. Status line: "Translator warming up (~1 min)" while the
cluster switches to translate mode (503 + Retry-After is retried automatically), then "Translating n/m sentences".
During playback the word highlight continues in the transcript and the translated sentence covering the current time
is highlighted too; click a translated sentence to seek. Copy/Download include the translation.

## Remove vocals (0.6.0)

Settings → **Remove vocals (karaoke)**, **off by default**; nothing is ever separated unless it is ticked. When on:
after the transcript (and the translation, if Translate is on) the background worker uploads the file to
`POST /v1/separate` and polls `GET /v1/jobs/<id>` every 2 s. A row under the status line shows progress
("Removing vocals on CUDA: 42%"), then **⬇ Download** (video with the lead voice removed, or an instrumental mp3) and a
**🎶 Instrumental / 🎤 Original** switch for the player; while the instrumental plays, the words highlighted are the
singer's (ASR on the vocals stem). Ticking it after a transcript removes the vocals of that file. **✕ Clear** cancels
polling and sends `DELETE /v1/jobs/<id>`, which deletes the job on the server. The chip shows "· no vocals" when on.
Needs service 0.7.0 (older servers: "server predates /v1/separate").
