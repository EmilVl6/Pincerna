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

echo "UI deployed to ${WWW_DIR}"

# Paths for services/configs we manage
SYSTEMD_UNIT_PATH="/etc/systemd/system/pincerna.service"
NGINX_SITE_AVAILABLE="/etc/nginx/sites-available/cloud.emilvinod.com"
NGINX_SITE_ENABLED="/etc/nginx/sites-enabled/cloud.emilvinod.com"

# --- Install or update systemd unit for backend ---
if [ -f "$SYSTEMD_UNIT_PATH" ]; then
  echo "Backing up existing systemd unit to ${SYSTEMD_UNIT_PATH}.bak"
  sudo cp -a "$SYSTEMD_UNIT_PATH" "${SYSTEMD_UNIT_PATH}.bak"
fi

echo "Writing systemd unit to ${SYSTEMD_UNIT_PATH}"
sudo tee "$SYSTEMD_UNIT_PATH" > /dev/null <<EOF
[Unit]
Description=Pincerna Flask API
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=${REPO_ROOT}
Environment=FLASK_ENV=production
ExecStart=/usr/bin/python3 ${REPO_ROOT}/services/api/app.py
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload || true
echo "Enabling and starting pincerna service"
sudo systemctl enable --now pincerna.service || sudo systemctl restart pincerna.service || true

# --- Install nginx site if example exists in repo ---
if [ -f "$REPO_ROOT/nginx/pincerna_auth.conf.example" ]; then
  if [ -f "$NGINX_SITE_AVAILABLE" ]; then
    echo "Backing up existing nginx site to ${NGINX_SITE_AVAILABLE}.bak"
    sudo cp -a "$NGINX_SITE_AVAILABLE" "${NGINX_SITE_AVAILABLE}.bak"
  fi
  echo "Installing nginx site from repo example"
  sudo install -m 644 "$REPO_ROOT/nginx/pincerna_auth.conf.example" "$NGINX_SITE_AVAILABLE"
  sudo ln -sf "$NGINX_SITE_AVAILABLE" "$NGINX_SITE_ENABLED"
fi

# Ensure nginx log dir exists and permissions are sane
sudo mkdir -p /var/log/nginx
sudo chown root:adm /var/log/nginx || true
sudo chmod 750 /var/log/nginx || true
sudo touch /var/log/nginx/error.log /var/log/nginx/access.log || true
sudo chmod 640 /var/log/nginx/*.log || true

echo "Testing nginx configuration"
if sudo nginx -t 2>/dev/null; then
  echo "Reloading nginx"
  sudo systemctl reload nginx || sudo systemctl restart nginx || true
else
  sudo nginx -t || true
  echo "nginx config test failed; not reloading. Inspect the output above."
fi

echo "Deployment complete. Backend service started (pincerna.service) and nginx updated if example present."
