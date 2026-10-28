#!/bin/bash
# Build the image, load it into k3s containerd, (re)deploy.
set -euo pipefail
cd "$(dirname "$0")/.."
docker build --build-arg GIT_SHA="$(git rev-parse --short HEAD)" -t parakeet-asr:dev .
docker save parakeet-asr:dev | sudo k3s ctr images import -
kubectl apply -f deploy/k8s/gpu-sharing.yaml -f deploy/k8s/asr.yaml
kubectl rollout restart deploy/parakeet-asr
kubectl rollout status deploy/parakeet-asr --timeout=10m
