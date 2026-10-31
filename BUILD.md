# Building Live Karaoke from scratch

This covers the Parakeet ASR service, the Chrome extension and the iOS app. Repo: https://github.com/wilddolphin2025/live-karaoke

The commands below come from the repo's own scripts (`deploy/install.sh`, `deploy/deploy.sh`, `Makefile`,
`extension/package.json`, `extension/scripts/*`, `ios/project.yml`). Where a step uses only standard tooling
(Xcode, `devicectl`), this guide says so.

## 1. Host prerequisites

Reference host: x86_64 laptop with Ubuntu, an RTX 3050 Laptop GPU (4 GB), and k3s on a single node.

1. **Ubuntu + NVIDIA driver.** Install the proprietary driver (e.g. `sudo ubuntu-drivers install`), reboot, and check `nvidia-smi`.
   The service image uses CUDA 12.8 wheels (`torch==2.11.0+cu128`), so the driver must support CUDA 12.8.
2. **Docker** (used by `deploy.sh` to build the image).
3. **NVIDIA Container Toolkit + k3s**, in one script:
   ```bash
   sudo deploy/install.sh
   ```
   It installs `nvidia-container-toolkit`, configures the Docker runtime, and installs k3s with
   `--write-kubeconfig-mode 644`. k3s detects `nvidia-container-runtime` and registers an `nvidia` containerd runtime.
   It also copies the kubeconfig to `~/.kube/config` and smoke-tests `docker run --gpus all ubuntu nvidia-smi -L` and `k3s kubectl get nodes`.
4. **Device plugin + time-slicing.** `deploy/k8s/gpu-sharing.yaml` (applied by `deploy.sh`) creates the `RuntimeClass nvidia`, a
   `nvidia-device-plugin` DaemonSet (`nvcr.io/nvidia/k8s-device-plugin:v0.17.1`), and a ConfigMap that advertises the one GPU
   as **2** `nvidia.com/gpu`. Check it with `kubectl describe node | grep nvidia.com/gpu` (should show 2).
5. **containerd image pinning** (done by `deploy.sh`): the translator image (`ghcr.io/ggml-org/llama.cpp:server-cuda@sha256:…`, ~3 GB),
   `curlimages/curl:8.10.1` and `parakeet-asr:dev` are pre-pulled and labelled `io.cri-containerd.pinned=pinned`, so image GC never
   evicts them and translate mode starts in about 30–60 s.
6. **kubelet image-GC thresholds** (done by `deploy.sh`): it adds to `/etc/rancher/k3s/config.yaml`
   ```yaml
   kubelet-arg:
     - "image-gc-high-threshold=95"
     - "image-gc-low-threshold=90"
   ```
   and restarts k3s once.
7. **Disk.** Plan on at least 40 GB free: service image ~10 GB+ (CUDA torch + NeMo) in both Docker and containerd, translator image ~3 GB,
   ASR model ~2.5 GB, GGUF 2.5 GB, Demucs weights 402 MB, plus job space (each job is refused below `JOBS_MIN_FREE_GB` = 5 GB free).
8. **Host paths.** The manifests mount `${MODEL_CACHE_DIR}` (models) and `${JOBS_CACHE_DIR}` from `deploy/local.env` (see [Configure for your setup](#configure-for-your-setup)).
   **Edit them** in `deploy/k8s/{asr,translator,separator}.yaml` for your user, and `mkdir -p ~/.cache/huggingface` (it is `type: Directory`).

## 2. Service

### Models
All models live in the host HF cache, mounted at `/models` (`HF_HOME=/models`).

| model | where | how it gets there |
|---|---|---|
| ASR `nvidia/nemotron-labs-unified-asr-0.6b` | `~/.cache/huggingface/hub/` | `ASRModel.from_pretrained` downloads it on the first pod start (or pre-fetch: `huggingface-cli download nvidia/nemotron-labs-unified-asr-0.6b`) |
| TranslateGemma GGUF `translategemma-4b-it.Q4_K_M.gguf` (2.5 GB) | `~/.cache/huggingface/gguf/` | the translator's `fetch-model` initContainer, from `mradermacher/translategemma-4b-it-GGUF`, on first start |
| Demucs `htdemucs_ft` + `htdemucs` (402 MB) | `~/.cache/huggingface/torch/` (`TORCH_HOME=/models/torch`) | pre-fetch once (below); the separator runs offline |

Pre-fetch the Demucs weights with the service image:
```bash
docker run --rm -v ~/.cache/huggingface:/models -e TORCH_HOME=/models/torch parakeet-asr:dev \
  python -c "from demucs.pretrained import get_model; get_model('htdemucs_ft'); get_model('htdemucs')"
```

### Build and deploy
```bash
cd ~/parakeet
deploy/deploy.sh      # runs sudo for: k3s ctr image import/pull/label, k3s config, systemctl restart k3s
```
What it does: `docker build --build-arg GIT_SHA=$(git rev-parse --short HEAD) -t parakeet-asr:dev .`, then
`docker save | sudo k3s ctr -n k8s.io images import -`, image pinning and GC thresholds (section 1), then
`kubectl apply` of `gpu-sharing`, `rbac`, `translator` (0 replicas), `separator` (0 replicas) and `asr` (2 replicas, NodePort **30800**).
It also resets to ASR mode, restarts a running separator on the new image, and waits for `rollout status deploy/parakeet-asr`.

Optional extras:
```bash
kubectl apply -f deploy/k8s/asr-ingress.yaml        # Traefik route /v1 with retry middleware, TLS secret ${TLS_SECRET_NAME}
deploy/make-cert.sh   # self-signed cert in deploy/tls/ (gitignored) + the TLS secret; apply ingresses from deploy/render.sh output
kubectl apply -f deploy/k8s/headlamp.yaml -f deploy/k8s/headlamp-ingress.yaml   # cluster UI
```

### Verify
```bash
curl -s http://localhost:30800/v1/info | python3 -m json.tool
#   service_version "0.7.0+<sha>", model, gpu, translation.mode "asr", separation.enabled true
kubectl get pods             # parakeet-asr x2 Running; translator/separator 0
curl -s -X POST --data-binary @some.wav 'http://localhost:30800/v1/listen?utterances=true&paragraphs=true'
curl -s -X POST -H 'Content-Type: application/json' -d '{"target":"en","sentences":[]}' http://localhost:30800/v1/translate  # 503 warm-up, then 200
```

### Tests
Use a dev venv (the `serve`/`transcribe` helpers expect `~/parakeet/.venv`):
```bash
python3 -m venv .venv && . .venv/bin/activate
pip install --extra-index-url https://download.pytorch.org/whl/cu128 -r requirements.txt
pytest -m "not accuracy"                          # unit tests (sentences, translate, separate, info, audio, wer)
ASR_URL=http://localhost:30800 pytest -m accuracy  # live tests: FLEURS ru WER + ru→en translation; need the server
                                                   # and benchmark audio in testdata/ (gitignored)
```
Benchmarks: `bench/wer_ru.py`, `bench/separate_bench.py`.

## 3. Chrome extension

Node 18+, plus `tar` and `zip`.
```bash
make extension                 # = cd extension && npm ci && npm run package
# or
cd extension
npm ci
npm run build                  # tsc --noEmit + esbuild + icons -> dist/
npm test                       # pure-helper unit tests (scripts/test.mjs)
npm run package                # -> release/parakeet-extension-<ver>.tar.gz and .zip (Web Store format)
```
End-to-end tests (headless, `puppeteer-core`; branded Chrome 137+ ignores `--load-extension`, so use **Chrome for Testing**):
```bash
npm i --no-save puppeteer-core
CHROME=/path/to/chrome-for-testing node scripts/e2e.mjs dist ../testdata/clip.mp3 240 before   # live; order: before|after|reopen
python3 scripts/sep_mock.py &                                                               # mock /v1/separate server
CHROME=... SEP_SERVER=http://<host>:18998 node scripts/sep_e2e.mjs dist clip.mp4 on          # scenarios: on|off|late|cancel
```
Load it: `chrome://extensions` → Developer mode → **Load unpacked** → `extension/dist` (or the extracted
`parakeet-extension/` folder from the tarball). In ⚙ Settings, set **Server** (empty on first run unless you built with `LK_SERVER` in `extension/local.env`; e.g. `http://YOUR_SERVER_IP:30800`).
Any other origin triggers a one-time permission prompt. To update: rebuild, then click reload on the extension card.

## 4. iOS app

Needs macOS, Xcode 15+ (iOS 17 SDK) and [XcodeGen](https://github.com/yonaskolb/XcodeGen).
```bash
brew install xcodegen
cd ios && ./scripts/generate.sh     # runs xcodegen: ParakeetKaraoke.xcodeproj from project.yml
open ParakeetKaraoke.xcodeproj
```
**Signing:** `DEVELOPMENT_TEAM` comes from `ios/Local.xcconfig` (gitignored; copy `ios/Local.xcconfig.example`) with automatic signing and the bundle id
`com.wilddolphin.parakeetkaraoke`. Forkers should change both to their own values, then re-run `xcodegen`:
```yaml
DEVELOPMENT_TEAM: <YOUR_TEAM_ID>
bundleIdPrefix: com.example
PRODUCT_BUNDLE_IDENTIFIER: com.example.parakeetkaraoke
```
**Optional private add-on (`LK_PREMIUM`), not needed for forks:** the app has a small hook layer
(`PremiumFeatures` in `Sources/PremiumHooks.swift`) whose default does nothing, and it builds and runs
completely without any add-on. The maintainer's private `LiveKaraokePremium` package is linked only
when the gitignored `ios/Local.xcconfig` contains
```
LK_PREMIUM = 1
LK_PREMIUM_PATH = ../../live-karaoke-premium   # package path relative to ios/
```
`scripts/generate.sh` then writes a gitignored `project.premium.yml` (includes `project.yml`, adds the
package, the `PREMIUM` Swift flag and the package's UI tests). Without these lines it just runs `xcodegen`.

**Simulator** (standard Xcode tooling):
```bash
xcodebuild -project ParakeetKaraoke.xcodeproj -scheme ParakeetKaraoke -destination 'platform=iOS Simulator,name=iPhone 15' -derivedDataPath build build
xcrun simctl boot 'iPhone 15'; xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/ParakeetKaraoke.app
xcrun simctl launch booted com.wilddolphin.parakeetkaraoke
xcrun simctl openurl booted 'parakeetkaraoke://import?url=http://<host>/song.mp4&title=Test&lang=auto'
```
**Device** (standard Xcode tooling):
```bash
xcodebuild -project ParakeetKaraoke.xcodeproj -scheme ParakeetKaraoke -destination generic/platform=iOS -derivedDataPath build -allowProvisioningUpdates build
xcrun devicectl list devices
xcrun devicectl device install app --device <DEVICE_ID> build/Build/Products/Debug-iphoneos/ParakeetKaraoke.app
```
**Server URL:** open Settings in the app (or `parakeetkaraoke://settings`). The default is `LK_DEFAULT_SERVER` from `ios/Local.xcconfig`, or empty (enter `http://YOUR_SERVER_IP:30800`). The first request
triggers the iOS Local Network prompt. ATS allows plain HTTP (`NSAllowsArbitraryLoads`).

## Configure for your setup

Nothing host-specific is committed. Copy the examples and fill in your values; the copies are gitignored.

```bash
cp deploy/local.env.example deploy/local.env          # k8s manifests, deploy.sh, make-cert.sh
cp extension/local.env.example extension/local.env    # optional: extension default server
cp ios/Local.xcconfig.example ios/Local.xcconfig      # iOS signing team + default server
DRY_RUN=1 deploy/deploy.sh                            # render manifests only, prints the output dir
```

| Placeholder | What it is | Where it is set | Example | How to find yours |
|---|---|---|---|---|
| `MODEL_CACHE_DIR` | Host dir with the HF cache, mounted at `/models` | `deploy/local.env` | `/home/alice/.cache/huggingface` | `echo $HOME/.cache/huggingface` on the GPU host |
| `JOBS_CACHE_DIR` | Host dir for vocal-removal job files | `deploy/local.env` | `/home/alice/.cache/parakeet-jobs` | any dir on the GPU host (created on first use) |
| `TLS_SECRET_NAME` | k8s TLS secret for the Traefik ingresses | `deploy/local.env` | `asr-tls` | your choice; `kubectl get secret` for existing |
| `ASR_HOSTNAME` | Server hostname (cert CN/SAN, https URL) | `deploy/local.env` | `gpubox` | `hostname` on the server |
| `ASR_HOST_IP` | Server LAN IP (cert SAN, client URLs) | `deploy/local.env` | `192.0.2.10` | `ip -4 addr` (Linux) / `ipconfig getifaddr en0` (macOS) |
| `YOUR_SERVER_IP:30800` | Server URL the clients use (NodePort 30800) | extension/iOS Settings | `http://192.0.2.10:30800` | `ASR_HOST_IP` + `kubectl get svc` |
| `LK_SERVER`, `LK_EXTRA_ORIGINS` | Extension default server and extra host permissions, baked in at build | `extension/local.env` (optional) | `http://192.0.2.10:30800`, `https://gpubox/*` | as above; without them the first run opens Settings |
| `DEVELOPMENT_TEAM` | Apple signing team ID | `ios/Local.xcconfig` | `ABCDE12345` | Xcode → Settings → Accounts, or developer.apple.com → Account → Membership |
| `LK_PREMIUM`, `LK_PREMIUM_PATH` | Optional, private: link the maintainer's add-on package (not needed for forks) | `ios/Local.xcconfig` (optional) | `1`, `../../live-karaoke-premium` | leave unset |
| `LK_DEFAULT_SERVER` | iOS default server (write `//` as `/$()/`) | `ios/Local.xcconfig` | `http:/$()/192.0.2.10:30800` | as above |
| TLS cert/key | Self-signed cert for `https://ASR_HOSTNAME` | `deploy/tls/` (gitignored) | `deploy/tls/gpubox.crt` | `deploy/make-cert.sh` (openssl), or `mkcert gpubox 192.0.2.10` |

The e2e script `extension/scripts/sep_e2e.mjs` reads `SEP_MOCK`/`SEP_SERVER` from the environment (default `http://localhost:18998`).
Package the extension (`npm run package`) on Linux: macOS BSD tar lacks `--transform`.
