#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
image=${JARVIS_SANDBOX_IMAGE:-openclaw-sandbox:bookworm-slim}
if sudo -u openclaw podman image exists "$image"; then
  printf 'SANDBOX_IMAGE_OK image=%s already present.\n' "$image"
  exit 0
fi
sudo -u openclaw podman build --pull=missing -t "$image" -f - . <<'DOCKERFILE'
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
  bash ca-certificates curl git jq python3 ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /bin/bash sandbox
USER sandbox
WORKDIR /home/sandbox
CMD ["sleep", "infinity"]
DOCKERFILE
sudo -u openclaw podman image exists "$image" || {
  echo 'SANDBOX_IMAGE_FAILED image was not created; service remains disabled.' >&2
  exit 1
}
printf 'SANDBOX_IMAGE_OK image=%s provisioned from the documented OpenClaw baseline.\n' "$image"
