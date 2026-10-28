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
scp slim:~/parakeet/extension/release/parakeet-extension-0.1.0.tar.gz ~/
mkdir -p ~/parakeet-ext && tar -xzf ~/parakeet-extension-0.1.0.tar.gz -C ~/parakeet-ext
# -> ~/parakeet-ext/parakeet-extension/manifest.json
```

You can also copy the folder directly: `scp -r slim:~/parakeet/extension/dist ~/parakeet-ext/parakeet-extension`.

Then in Chrome:

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select `~/parakeet-ext/parakeet-extension`.
3. Pin "Parakeet ASR" and click the icon. A 480x640 window opens. Drop a wav/mp3/flac/ogg/m4a/webm file on it or click to pick one.

To update: rebuild, re-extract over the same folder, then click the reload button on the extension card.

## Settings

- **Server**: default `http://192.168.8.226:30800` (NodePort). `https://slim` (Traefik) also works. Any other URL triggers a one-time Chrome permission prompt (`optional_host_permissions`).
- **Language**: `auto` or a language code. Both are saved in `chrome.storage.local`.

## Self-signed cert (https://slim)

Chrome rejects the self-signed certificate until you trust it. Open `https://slim/` in a tab once and accept the warning (Advanced, then Proceed), or add the cert to your system keychain as trusted. Until then you get a "Network error". The machine also has to resolve `slim` (for example via /etc/hosts). The default `http://192.168.8.226:30800` avoids all of this.

## CORS

None needed. The request comes from the extension page, and `host_permissions` exempt it from CORS. The server is unchanged.
