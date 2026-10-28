#!/bin/bash
# Build the image, load it into k3s containerd, (re)deploy.
set -euo pipefail
cd "$(dirname "$0")/.."
docker build --build-arg GIT_SHA="$(git rev-parse --short HEAD)" -t parakeet-asr:dev .
docker save parakeet-asr:dev | sudo k3s ctr images import -
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
