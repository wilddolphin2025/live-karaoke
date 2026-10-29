#!/bin/bash
# Self-signed TLS cert for the Traefik ingress: deploy/tls/$ASR_HOSTNAME.{crt,key} (gitignored), then the k8s secret.
# Values from deploy/local.env: ASR_HOSTNAME, ASR_HOST_IP, TLS_SECRET_NAME. (mkcert works too: mkcert $ASR_HOSTNAME $ASR_HOST_IP)
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f deploy/local.env ] && { set -a; . deploy/local.env; set +a; }
: "${ASR_HOSTNAME:?set ASR_HOSTNAME}" "${ASR_HOST_IP:?set ASR_HOST_IP}" "${TLS_SECRET_NAME:=asr-tls}"
mkdir -p deploy/tls
openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=$ASR_HOSTNAME" \
  -addext "subjectAltName=DNS:$ASR_HOSTNAME,IP:$ASR_HOST_IP" \
  -keyout "deploy/tls/$ASR_HOSTNAME.key" -out "deploy/tls/$ASR_HOSTNAME.crt"
[ "${NO_SECRET:-0}" = 1 ] || kubectl create secret tls "$TLS_SECRET_NAME" --cert="deploy/tls/$ASR_HOSTNAME.crt" \
  --key="deploy/tls/$ASR_HOSTNAME.key" --dry-run=client -o yaml | kubectl apply -f -
