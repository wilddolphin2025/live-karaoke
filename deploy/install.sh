#!/bin/bash
# Run once with sudo: NVIDIA Container Toolkit + k3s (with GPU runtime).
set -euo pipefail
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  > /etc/apt/sources.list.d/nvidia-container-toolkit.list
apt-get update -qq && apt-get install -y -qq nvidia-container-toolkit
nvidia-ctk runtime configure --runtime=docker && systemctl restart docker
# k3s detects nvidia-container-runtime and registers an "nvidia" containerd runtime.
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--write-kubeconfig-mode 644" sh -
mkdir -p /home/${SUDO_USER}/.kube && cp /etc/rancher/k3s/k3s.yaml /home/${SUDO_USER}/.kube/config
chown -R ${SUDO_USER}: /home/${SUDO_USER}/.kube
echo "== GPU in docker:"; docker run --rm --gpus all ubuntu nvidia-smi -L
echo "== k3s:"; k3s kubectl get nodes
