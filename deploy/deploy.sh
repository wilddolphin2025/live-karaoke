#!/bin/bash
# Build the image, load it into k3s containerd, (re)deploy.
set -euo pipefail
cd "$(dirname "$0")/.."
docker build --build-arg GIT_SHA="$(git rev-parse --short HEAD)" -t parakeet-asr:dev .
docker save parakeet-asr:dev | sudo k3s ctr -n k8s.io images import -

# Keep the translator image (~3 GB) cached so translate mode starts in ~30-60 s (model load only),
# not 3+ min of pulling: pre-pull the pinned digest and mark it pinned so kubelet image GC never evicts it.
TR_IMAGE=$(sed -n 's/^ *image: *\(ghcr.io\/ggml-org\/llama.cpp[^ ]*\).*/\1/p' deploy/k8s/translator.yaml)
for img in "$TR_IMAGE" docker.io/curlimages/curl:8.10.1 docker.io/library/parakeet-asr:dev; do
  sudo k3s ctr -n k8s.io images ls -q | grep -qxF "$img" || sudo k3s ctr -n k8s.io images pull "$img"
  sudo k3s ctr -n k8s.io images label "$img" io.cri-containerd.pinned=pinned >/dev/null
done

# Image GC: kubelet's default (85 % high / 80 % low) fires at this disk's usage; raise it.
CFG=/etc/rancher/k3s/config.yaml
if ! sudo grep -q image-gc-high-threshold "$CFG" 2>/dev/null; then
  sudo mkdir -p /etc/rancher/k3s
  if sudo grep -q '^kubelet-arg:' "$CFG" 2>/dev/null; then
    sudo sed -i '/^kubelet-arg:/a\  - "image-gc-high-threshold=95"\n  - "image-gc-low-threshold=90"' "$CFG"
  else
    printf 'kubelet-arg:\n  - "image-gc-high-threshold=95"\n  - "image-gc-low-threshold=90"\n' | sudo tee -a "$CFG" >/dev/null
  fi
  echo "k3s config changed: restarting k3s (pods keep running)"
  sudo systemctl restart k3s
  until kubectl get nodes >/dev/null 2>&1; do sleep 2; done
fi
# Keep the current translator replica count (0 unless translate mode is active);
# a plain apply would reset it to the manifest's 0.
TR=$(kubectl get deploy translator -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 0)
# 0.6.0 replaced Riva-Translate with TranslateGemma and renamed riva-translate -> translator.
kubectl delete deploy/riva-translate svc/riva-translate --ignore-not-found
kubectl apply -f deploy/k8s/gpu-sharing.yaml -f deploy/k8s/rbac.yaml \
  -f deploy/k8s/translator.yaml -f deploy/k8s/asr.yaml
if [ "${TR:-0}" -gt 0 ]; then
  kubectl scale deploy/translator --replicas=0   # restart in plain asr mode
fi
kubectl rollout restart deploy/parakeet-asr
kubectl rollout status deploy/parakeet-asr --timeout=10m
