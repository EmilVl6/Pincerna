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


SYSTEMD_UNIT_PATH="/etc/systemd/system/pincerna.service"
NGINX_SITE_AVAILABLE="/etc/nginx/sites-available/cloud.emilvinod.com"
NGINX_SITE_ENABLED="/etc/nginx/sites-enabled/cloud.emilvinod.com"


if [ -f "$SYSTEMD_UNIT_PATH" ]; then
  echo "Backing up existing systemd unit to ${SYSTEMD_UNIT_PATH}.bak"
  sudo cp -a "$SYSTEMD_UNIT_PATH" "${SYSTEMD_UNIT_PATH}.bak"
fi


VENV_PATH="$REPO_ROOT/venv"
REQ_FILE="$REPO_ROOT/services/api/requirements.txt"
if [ ! -d "$VENV_PATH" ]; then
  echo "Creating venv at $VENV_PATH"
  sudo python3 -m venv "$VENV_PATH"
  sudo "$VENV_PATH/bin/pip" install --upgrade pip setuptools wheel || true
fi
if [ -f "$REQ_FILE" ]; then
  echo "Installing Python requirements from $REQ_FILE"
  sudo "$VENV_PATH/bin/pip" install -r "$REQ_FILE" || true
fi
sudo chown -R www-data:www-data "$VENV_PATH" || true

API_LOG="$REPO_ROOT/api.log"
if [ ! -f "$API_LOG" ]; then
  sudo touch "$API_LOG"
fi
sudo chown www-data:www-data "$API_LOG" || true
sudo chmod 640 "$API_LOG" || true

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
ExecStart=${VENV_PATH}/bin/gunicorn -b 127.0.0.1:5002 services.api.app:app --workers 2 --chdir ${REPO_ROOT}
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload || true
echo "Enabling and starting pincerna service"
sudo systemctl enable --now pincerna.service || sudo systemctl restart pincerna.service || true


if [ -f "$REPO_ROOT/nginx/pincerna_auth.conf.example" ]; then
  if [ -f "$NGINX_SITE_AVAILABLE" ]; then
    echo "Backing up existing nginx site to ${NGINX_SITE_AVAILABLE}.bak"
    sudo cp -a "$NGINX_SITE_AVAILABLE" "${NGINX_SITE_AVAILABLE}.bak"
  fi
  echo "Installing nginx site from repo example"
  sudo install -m 644 "$REPO_ROOT/nginx/pincerna_auth.conf.example" "$NGINX_SITE_AVAILABLE"
  sudo ln -sf "$NGINX_SITE_AVAILABLE" "$NGINX_SITE_ENABLED"
  
  if sudo grep -q "listen 443" "$NGINX_SITE_AVAILABLE" && ! sudo grep -q "ssl_certificate" "$NGINX_SITE_AVAILABLE"; then
    SSLCERT=/etc/ssl/certs/cloud.emilvinod.com.crt
    SSLKEY=/etc/ssl/private/cloud.emilvinod.com.key
    if [ ! -f "$SSLCERT" ] || [ ! -f "$SSLKEY" ]; then
      echo "Creating temporary self-signed certificate at $SSLCERT"
      sudo mkdir -p /etc/ssl/private /etc/ssl/certs
      sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "$SSLKEY" -out "$SSLCERT" -subj "/CN=cloud.emilvinod.com" || true
      sudo chmod 640 "$SSLKEY" || true
      sudo chmod 644 "$SSLCERT" || true
    fi
    
    sudo sed -i "/server_name cloud.emilvinod.com;/a \    ssl_certificate $SSLCERT;\n    ssl_certificate_key $SSLKEY;" "$NGINX_SITE_AVAILABLE" || true
  fi
fi


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
