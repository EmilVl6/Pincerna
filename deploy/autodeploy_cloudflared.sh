#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root: sudo bash deploy/autodeploy_cloudflared.sh" >&2
  exit 1
fi

read -rp "Repo path on Pi [$(pwd)]: " APP_DIR
APP_DIR=${APP_DIR:-$(pwd)}
read -rp "Service user to run app [pi]: " APP_USER
APP_USER=${APP_USER:-pi}
read -rp "Hostname to expose via Cloudflare (e.g. cloud.emilvinod.com): " DOMAIN
DOMAIN=${DOMAIN:-cloud.emilvinod.com}
read -rp "Cloudflare Tunnel token (create a Tunnel in Cloudflare and paste the token): " CF_TOKEN

VEV="$APP_DIR/services/api/.venv"
WWW="/var/www/pincerna"

echo "Installing packages..."
apt update
apt install -y nginx python3-venv python3-pip curl

echo "Installing cloudflared..."
TMPDEB=/tmp/cloudflared.deb
ARCH=$(dpkg --print-architecture)
if [ "$ARCH" = "arm64" ]; then
  URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb"
else
  URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb"
fi
curl -L "$URL" -o "$TMPDEB"
apt install -y "$TMPDEB"
rm -f "$TMPDEB"

echo "Copying UI to $WWW..."
mkdir -p "$WWW"
cp -r "$APP_DIR/services/ui/"* "$WWW/"
chown -R www-data:www-data "$WWW"

echo "Installing nginx site (HTTP only)..."
NGINX_SITE="/etc/nginx/sites-available/pincerna"
cat > "$NGINX_SITE" <<EOF
server {
  listen 127.0.0.1:80;
  listen [::1]:80;
  server_name $DOMAIN;

  root $WWW;
  index index.html;

  location /cloud/ {
    try_files \$uri \$uri/ /cloud/index.html;
  }

  location /cloud/api/ {
    proxy_pass http://127.0.0.1:5002/;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }
}
EOF
ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/pincerna
nginx -t
systemctl reload nginx

echo "Creating Python virtualenv and installing requirements..."
python3 -m venv "$VEV"
"$VEV/bin/pip" install --upgrade pip
if [ -f "$APP_DIR/services/api/requirements.txt" ]; then
  "$VEV/bin/pip" install -r "$APP_DIR/services/api/requirements.txt"
fi

echo "Writing systemd service for Flask (pincerna)..."
cat > /etc/systemd/system/pincerna.service <<EOF
[Unit]
Description=Pincerna Flask API
After=network.target

[Service]
User=$APP_USER
Group=www-data
WorkingDirectory=$APP_DIR/services/api
Environment="PATH=$VEV/bin"
ExecStart=$VEV/bin/gunicorn -w 2 -b 127.0.0.1:5002 app:app
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now pincerna.service

echo "Writing cloudflared systemd service (cloudflared-tunnel)..."
cat > /etc/systemd/system/cloudflared-tunnel.service <<EOF
[Unit]
Description=Cloudflared Tunnel for Pincerna
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=TOKEN=${CF_TOKEN}
ExecStart=/usr/local/bin/cloudflared tunnel --url http://127.0.0.1:80 run --token=\$TOKEN
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now cloudflared-tunnel.service

echo
echo "Done. The tunnel connects the hostname $DOMAIN to the Pi's local nginx (HTTP)."
echo "In Cloudflare DNS, create a CNAME for $DOMAIN pointing to the tunnel if not already routed (or use the named tunnel route in the Cloudflare dashboard)."
echo "To see logs: sudo journalctl -u cloudflared-tunnel -f"
