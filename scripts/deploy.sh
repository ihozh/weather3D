#!/usr/bin/env bash
# Pull the latest code from origin and apply on the VPS.
# Run as the same user that owns /opt/weather3d (not root).
#
# Usage:
#   bash scripts/deploy.sh           # standard: pull + venv + nginx reload
#   bash scripts/deploy.sh --skip-pip   # don't refresh python deps
#
# Returns non-zero if anything fails.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

SKIP_PIP=0
for arg in "$@"; do
  case "$arg" in
    --skip-pip) SKIP_PIP=1 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

echo "==> Fetching from origin"
git fetch --quiet origin
LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse '@{u}')"

if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
  echo "Already up to date ($LOCAL_HEAD)."
else
  echo "==> Pulling $LOCAL_HEAD -> $REMOTE_HEAD"
  git pull --ff-only --quiet
fi

REQ_FILE="requirements-hrrr.txt"
if [ "$SKIP_PIP" -eq 0 ] && [ -f "$REQ_FILE" ]; then
  # Refresh deps only if requirements changed since last venv update.
  STAMP=".venv/.last-deploy-req-hash"
  CURRENT_HASH="$(sha256sum "$REQ_FILE" | awk '{print $1}')"
  LAST_HASH=""
  [ -f "$STAMP" ] && LAST_HASH="$(cat "$STAMP")"
  if [ "$CURRENT_HASH" != "$LAST_HASH" ]; then
    echo "==> requirements changed, refreshing venv"
    .venv/bin/python -m pip install --upgrade pip --quiet
    .venv/bin/python -m pip install -r "$REQ_FILE" --quiet
    echo "$CURRENT_HASH" > "$STAMP"
  else
    echo "Python deps unchanged."
  fi
fi

# Reload the hourly HRRR timer + nginx config (no-op if not installed).
if systemctl --user --quiet is-active weather3d-hrrr.timer 2>/dev/null; then :; fi
if command -v systemctl >/dev/null && systemctl list-unit-files | grep -q weather3d-hrrr.timer; then
  echo "==> Restarting weather3d-hrrr timer"
  sudo systemctl restart weather3d-hrrr.timer
fi

if command -v nginx >/dev/null; then
  echo "==> Reloading nginx"
  sudo nginx -t
  sudo systemctl reload nginx
fi

echo "Deploy OK at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
