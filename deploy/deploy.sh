#!/bin/bash
# Deploy script for production server.
# Enforced via ForceCommand in sshd_config — the deploy user can only ever run
# this script via SSH, regardless of what command the client requests.
# The GITHUB_TOKEN passed by the CI workflow is used to pull private ghcr.io
# images ephemerally; no credentials are stored on the server.
#
# Server setup (one-time):
#   1. Create deploy user:
#        useradd -r -m -s /bin/bash deploy
#        usermod -aG docker deploy
#   2. Create /data/docker/eink/ and place your production docker-compose.yml + .env there.
#   3. Copy this script to /data/docker/eink/deploy.sh and make it executable:
#        chmod +x /data/docker/eink/deploy.sh
#   4. Add the CI deploy public key to /home/deploy/.ssh/authorized_keys with a forced command:
#        command="/data/docker/eink/deploy.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA...
#
#      The CI sends "GHCR_TOKEN=<token> GITHUB_ACTOR=<actor>" as the SSH command.
#      SSH puts that string in $SSH_ORIGINAL_COMMAND; the script parses it below.
#      No changes to sshd_config are needed.
#
# GitHub secrets (Repo → Settings → Secrets and variables → Actions):
#   SSH_HOST         — production server IP or hostname
#   SSH_USER         — deploy user created in step 1 (e.g. "deploy")
#   SSH_PRIVATE_KEY  — private half of the SSH key pair (the public half goes in authorized_keys)
#   SSH_PORT         — SSH port on the server (omit if 22)
#   PUBLIC_SITE_URL  — public URL of the frontend, e.g. https://eink.example.com
#                      (baked into the frontend image at build time by the CD workflow)
#
# Note: GITHUB_TOKEN is provided automatically by GitHub Actions — no manual secret needed.

set -euo pipefail

DEPLOY_DIR="/data/docker/eink"

echo "[deploy] Starting deployment at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

cd "$DEPLOY_DIR"

# Parse GHCR_TOKEN and GITHUB_ACTOR from the string sent by the CI as the SSH command.
# Expected format: "GHCR_TOKEN=xxx GITHUB_ACTOR=yyy"
GHCR_TOKEN=$(echo "${SSH_ORIGINAL_COMMAND:-}" | grep -oP 'GHCR_TOKEN=\K\S+')
GITHUB_ACTOR=$(echo "${SSH_ORIGINAL_COMMAND:-}" | grep -oP 'GITHUB_ACTOR=\K\S+')

if [[ -z "$GHCR_TOKEN" || -z "$GITHUB_ACTOR" ]]; then
  echo "[deploy] ERROR: GHCR_TOKEN or GITHUB_ACTOR missing from SSH_ORIGINAL_COMMAND." >&2
  exit 1
fi

echo "[deploy] Logging in to ghcr.io as ${GITHUB_ACTOR}..."
echo "${GHCR_TOKEN}" | docker login ghcr.io -u "${GITHUB_ACTOR}" --password-stdin

echo "[deploy] Pulling latest images..."
docker compose pull

docker logout ghcr.io

echo "[deploy] Restarting services..."
docker compose up -d --remove-orphans

echo "[deploy] Pruning unused images..."
docker image prune -f

echo "[deploy] Done."
