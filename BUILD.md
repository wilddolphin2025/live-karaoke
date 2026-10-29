# Building Live Karaoke from scratch

This covers the Parakeet ASR service, the Chrome extension and the iOS app. Repo: https://github.com/wilddolphin2025/live-karaoke

The commands below come from the repo's own scripts (`deploy/install.sh`, `deploy/deploy.sh`, `Makefile`,
`extension/package.json`, `extension/scripts/*`, `ios/project.yml`). Where a step uses only standard tooling
(Xcode, `devicectl`), this guide says so.

## 1. Host prerequisites

Reference host `slim`: x86_64 laptop with Ubuntu, an RTX 3050 Laptop GPU (4 GB), and k3s on a single node.

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
8. **Host paths.** The manifests mount `/home/ykiryanov/.cache/huggingface` (models) and `/home/ykiryanov/.cache/parakeet-jobs`.
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
kubectl apply -f deploy/k8s/asr-ingress.yaml        # Traefik route /v1 with retry middleware, TLS secret slim-tls
kubectl create secret tls slim-tls --cert=deploy/tls/slim.crt --key=deploy/tls/slim.key   # key is gitignored: make your own
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
`parakeet-extension/` folder from the tarball). In ⚙ Settings, set **Server** (default `http://192.168.8.226:30800`).
Any other origin triggers a one-time permission prompt. To update: rebuild, then click reload on the extension card.

## 4. iOS app

Needs macOS, Xcode 15+ (iOS 17 SDK) and [XcodeGen](https://github.com/yonaskolb/XcodeGen).
```bash
brew install xcodegen
cd ios && xcodegen                   # generates ParakeetKaraoke.xcodeproj from project.yml
open ParakeetKaraoke.xcodeproj
```
**Signing:** `project.yml` sets `DEVELOPMENT_TEAM: PPZTNTHDFC` (the original author's team) with automatic signing and the bundle id
`com.wilddolphin.parakeetkaraoke`. Forkers should change both to their own values, then re-run `xcodegen`:
```yaml
DEVELOPMENT_TEAM: <YOUR_TEAM_ID>
bundleIdPrefix: com.example
PRODUCT_BUNDLE_IDENTIFIER: com.example.parakeetkaraoke
```
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
**Server URL:** open Settings in the app (or `parakeetkaraoke://settings`). The default is `http://192.168.8.226:30800`. The first request
triggers the iOS Local Network prompt. ATS allows plain HTTP (`NSAllowsArbitraryLoads`).
