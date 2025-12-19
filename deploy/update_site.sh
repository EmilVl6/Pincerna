#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$REPO_ROOT/services/ui"
WWW_DIR="/var/www/pincerna/cloud"

echo "Deploying UI from ${SRC_DIR} -> ${WWW_DIR}"

if [ ! -d "$SRC_DIR" ]; then
  echo "Source directory not found: $SRC_DIR" >&2
  exit 1
fi


sudo mkdir -p "$(dirname "$WWW_DIR")"
sudo rsync -a --delete --chown=www-data:www-data "$SRC_DIR/" "$WWW_DIR/"

sudo chown -R www-data:www-data "$(dirname "$WWW_DIR")"

sudo systemctl reload nginx

echo "Deployment complete."
