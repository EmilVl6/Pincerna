#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
UI_SRC="$REPO_ROOT/services/ui"
API_SRC="$REPO_ROOT/services/api"
WEB_ROOT="/var/www/pincerna"
API_DEST="/opt/pincerna"
SERVICE_NAME="pincerna"
ENV_FILE="/etc/default/pincerna"
FILES_ROOT="/home/pincerna/files"
echo "=== Pincerna Deployment ==="
echo "Step 1: Checking dependencies..."
PACKAGES="nginx python3 python3-venv python3-pip wireguard"
MISSING=""
for pkg in $PACKAGES; do
    if ! dpkg -s "$pkg" >/dev/null 2>&1; then
        MISSING="$MISSING $pkg"
    fi
done
if [ -n "$MISSING" ]; then
    echo "Installing missing packages:$MISSING"
    sudo apt-get update
    sudo apt-get install -y $MISSING
else
    echo "All dependencies already installed"
fi
echo "Step 2: Configuring credentials..."
if [ ! -f "$ENV_FILE" ]; then
    echo "Environment file not found. Please provide credentials:"
    read -rp "Cloudflare Turnstile Site Key: " TURNSTILE_SITEKEY
    read -rp "Cloudflare Turnstile Secret Key: " TURNSTILE_SECRET
    read -rp "Google OAuth Client ID: " GOOGLE_CLIENT_ID
    read -rp "Google OAuth Client Secret: " GOOGLE_CLIENT_SECRET
    sudo tee "$ENV_FILE" > /dev/null << ENVEOF
TURNSTILE_SITEKEY=$TURNSTILE_SITEKEY
TURNSTILE_SECRET=$TURNSTILE_SECRET
GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET
FILES_ROOT=$FILES_ROOT
ENVEOF
    sudo chmod 600 "$ENV_FILE"
    echo "Credentials saved to $ENV_FILE"
else
    echo "Credentials already configured"
fi
echo "Step 3: Setting up file storage..."
if [ ! -d "$FILES_ROOT" ]; then
    sudo mkdir -p "$FILES_ROOT"
    sudo chown www-data:www-data "$FILES_ROOT"
    sudo chmod 755 "$FILES_ROOT"
    echo "Created $FILES_ROOT"
else
    echo "File storage already exists"
fi
echo "Step 4: Configuring WireGuard..."
if [ ! -f /etc/wireguard/wg0.conf ]; then
    echo "WireGuard config not found at /etc/wireguard/wg0.conf"
    echo "Please create it manually with your VPN configuration"
else
    echo "WireGuard config exists"
fi
SUDOERS_FILE="/etc/sudoers.d/pincerna-wg"
if [ ! -f "$SUDOERS_FILE" ]; then
    echo "www-data ALL=(ALL) NOPASSWD: /usr/bin/wg-quick up wg0" | sudo tee "$SUDOERS_FILE" > /dev/null
    echo "www-data ALL=(ALL) NOPASSWD: /usr/bin/wg-quick down wg0" >> "$SUDOERS_FILE"
    echo "www-data ALL=(ALL) NOPASSWD: /usr/bin/wg show wg0" >> "$SUDOERS_FILE"
    sudo chmod 440 "$SUDOERS_FILE"
    echo "Sudoers configured for WireGuard"
else
    echo "Sudoers already configured"
fi
echo "Step 5: Setting up Python environment..."
sudo mkdir -p "$API_DEST"
for f in "$API_SRC"/*; do
    fname=$(basename "$f")
    if [ "$fname" != "venv" ] && [ "$fname" != "__pycache__" ]; then
        sudo cp -r "$f" "$API_DEST"/
    fi
done
if [ ! -d "$API_DEST/venv" ]; then
    sudo python3 -m venv "$API_DEST/venv"
    echo "Created Python virtual environment"
fi
sudo "$API_DEST/venv/bin/pip" install --quiet --upgrade pip
sudo "$API_DEST/venv/bin/pip" install --quiet flask gunicorn pyjwt psutil
echo "Python dependencies installed"
echo "Step 6: Deploying UI..."
sudo mkdir -p "$WEB_ROOT"
sudo cp -r "$UI_SRC"/* "$WEB_ROOT"/
sudo chown -R www-data:www-data "$WEB_ROOT"
echo "UI deployed to $WEB_ROOT"
echo "Step 7: Configuring services..."
sudo tee /etc/systemd/system/$SERVICE_NAME.service > /dev/null << SVCEOF
[Unit]
Description=Pincerna API
After=network.target
[Service]
User=www-data
Group=www-data
WorkingDirectory=$API_DEST
EnvironmentFile=$ENV_FILE
ExecStart=$API_DEST/venv/bin/gunicorn --workers 2 --bind 127.0.0.1:5002 app:app
Restart=always
[Install]
WantedBy=multi-user.target
SVCEOF
if [ ! -f /etc/nginx/sites-available/pincerna ]; then
    sudo tee /etc/nginx/sites-available/pincerna > /dev/null << 'NGXEOF'
server {
    listen 443 ssl;
    server_name _;
    ssl_certificate /etc/ssl/certs/ssl-cert-snakeoil.pem;
    ssl_certificate_key /etc/ssl/private/ssl-cert-snakeoil.key;
    location /cloud/ {
        alias /var/www/pincerna/;
        index index.html;
        try_files $uri $uri/ /cloud/index.html;
    }
    location /cloud/api/ {
        proxy_pass http://127.0.0.1:5002/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGXEOF
    sudo ln -sf /etc/nginx/sites-available/pincerna /etc/nginx/sites-enabled/
    echo "Nginx configured"
else
    echo "Nginx config already exists"
fi
echo "Step 8: Starting services..."
sudo systemctl daemon-reload
sudo systemctl enable $SERVICE_NAME
sudo systemctl restart $SERVICE_NAME
sudo nginx -t && sudo systemctl reload nginx
echo ""
echo "=== Deployment Complete ==="
echo "API: http://127.0.0.1:5002"
echo "Web: https://your-domain/cloud/"
