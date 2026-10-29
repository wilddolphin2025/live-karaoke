#!/bin/bash
# Render deploy/k8s/*.yaml with the values from deploy/local.env (or the environment) into $OUT (default: a temp dir).
# Usage: deploy/render.sh [outdir]      -> prints the output dir. Only ${MODEL_CACHE_DIR} ${JOBS_CACHE_DIR}
# ${TLS_SECRET_NAME} are substituted, so llama.cpp's $(N_GPU_LAYERS) style references are left alone.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f deploy/local.env ] && { set -a; . deploy/local.env; set +a; }
: "${MODEL_CACHE_DIR:=$HOME/.cache/huggingface}" "${JOBS_CACHE_DIR:=$HOME/.cache/parakeet-jobs}" "${TLS_SECRET_NAME:=asr-tls}"
export MODEL_CACHE_DIR JOBS_CACHE_DIR TLS_SECRET_NAME
OUT=${1:-$(mktemp -d)}
mkdir -p "$OUT"
for f in deploy/k8s/*.yaml; do
  envsubst '${MODEL_CACHE_DIR} ${JOBS_CACHE_DIR} ${TLS_SECRET_NAME}' < "$f" > "$OUT/$(basename "$f")"
done
echo "$OUT"
