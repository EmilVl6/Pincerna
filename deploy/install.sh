#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "This script must be run as root (sudo)." >&2
  exit 1
fi

read -rp "Enter full path to this repository on the Pi [$(pwd)]: " APP_DIR
APP_DIR=${APP_DIR:-$(pwd)}
read -rp "Enter the system user that should run the app [pi]: " APP_USER
APP_USER=${APP_USER:-pi}
read -rp "Enter domain to configure [cloud.emilvinod.com]: " DOMAIN
DOMAIN=${DOMAIN:-cloud.emilvinod.com}

VEV="$APP_DIR/services/api/.venv"
WWW="/var/www/pincerna"
LE="/var/www/letsencrypt"
NGINX_SITE="/etc/nginx/sites-available/pincerna"

echo "Copying UI to $WWW..."
mkdir -p "$WWW"
cp -r "$APP_DIR/services/ui/"* "$WWW/"
chown -R www-data:www-data "$WWW"

echo "Preparing ACME webroot $LE..."
mkdir -p "$LE"
chown -R www-data:www-data "$LE"

echo "Installing nginx site..."
cp "$APP_DIR/nginx/nginx.conf" "$NGINX_SITE"
ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/pincerna
nginx -t
systemctl reload nginx

echo "Creating Python virtualenv at $VEV and installing requirements..."
python3 -m venv "$VEV"
"$VEV/bin/pip" install --upgrade pip
if [ -f "$APP_DIR/services/api/requirements.txt" ]; then
  "$VEV/bin/pip" install -r "$APP_DIR/services/api/requirements.txt"
else
  echo "requirements.txt not found; installing basic packages..."
  "$VEV/bin/pip" install flask pyjwt psutil gunicorn
fi

echo "Writing systemd service /etc/systemd/system/pincerna.service..."
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

echo
echo "Optional: obtain a TLS certificate for $DOMAIN using Certbot (webroot)."
read -rp "Request cert now (y/N)? " REQ
if [[ "$REQ" =~ ^[Yy] ]]; then
  certbot certonly --webroot -w "$LE" -d "$DOMAIN"
  systemctl reload nginx
  echo "If cert issued, nginx will use /etc/letsencrypt/live/$DOMAIN/ by default in the repo config." 
fi

echo "Done. Visit https://$DOMAIN/cloud/ after DNS points to this machine and certs are in place."
