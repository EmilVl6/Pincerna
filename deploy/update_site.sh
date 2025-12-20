#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$REPO_ROOT/services/ui"
WWW_DIR="/var/www/pincerna/cloud"
FILES_ROOT="/home/pincerna/files"

echo "========================================="
echo "Pincerna Deployment Script"
echo "========================================="

# =========================================
# 1. Deploy UI files
# =========================================
echo ""
echo "[1/7] Deploying UI from ${SRC_DIR} -> ${WWW_DIR}"

if [ ! -d "$SRC_DIR" ]; then
  echo "Source directory not found: $SRC_DIR" >&2
  exit 1
fi

sudo mkdir -p "$(dirname "$WWW_DIR")"
sudo rsync -a --delete --chown=www-data:www-data "$SRC_DIR/" "$WWW_DIR/"
sudo chown -R www-data:www-data "$(dirname "$WWW_DIR")"
echo "UI deployed to ${WWW_DIR}"

# =========================================
# 2. Set up file storage directory
# =========================================
echo ""
echo "[2/7] Setting up file storage at ${FILES_ROOT}"

sudo mkdir -p "$FILES_ROOT"
sudo chown www-data:www-data "$FILES_ROOT"
sudo chmod 750 "$FILES_ROOT"
echo "File storage ready at ${FILES_ROOT}"

# =========================================
# 3. Install WireGuard VPN
# =========================================
echo ""
echo "[3/7] Setting up WireGuard VPN"

if ! command -v wg &> /dev/null; then
  echo "Installing WireGuard..."
  sudo apt-get update -qq
  sudo apt-get install -y wireguard wireguard-tools
fi

WG_CONF="/etc/wireguard/wg0.conf"
if [ ! -f "$WG_CONF" ]; then
  echo "Creating WireGuard configuration template..."
  
  # Generate keys if they don't exist
  WG_PRIVKEY="/etc/wireguard/privatekey"
  WG_PUBKEY="/etc/wireguard/publickey"
  if [ ! -f "$WG_PRIVKEY" ]; then
    sudo bash -c "wg genkey > $WG_PRIVKEY"
    sudo chmod 600 "$WG_PRIVKEY"
    sudo bash -c "cat $WG_PRIVKEY | wg pubkey > $WG_PUBKEY"
    sudo chmod 644 "$WG_PUBKEY"
    echo "Generated WireGuard keys"
  fi
  
  PRIVKEY=$(sudo cat "$WG_PRIVKEY")
  
  # Create a template config - user needs to fill in peer details
  sudo tee "$WG_CONF" > /dev/null <<WGEOF
[Interface]
# This server's private key
PrivateKey = ${PRIVKEY}
# VPN subnet address for this server
Address = 10.0.0.1/24
# Port to listen on
ListenPort = 51820
# Enable IP forwarding when interface comes up
PostUp = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE

# Add peer configs below (one [Peer] section per client)
# [Peer]
# PublicKey = <client-public-key>
# AllowedIPs = 10.0.0.2/32
WGEOF
  sudo chmod 600 "$WG_CONF"
  
  PUBKEY=$(sudo cat "$WG_PUBKEY")
  echo ""
  echo "========================================="
  echo "WireGuard server public key:"
  echo "$PUBKEY"
  echo "========================================="
  echo "Edit $WG_CONF to add peer configurations"
  echo ""
else
  echo "WireGuard config already exists at $WG_CONF"
fi

# Enable IP forwarding
if ! grep -q "net.ipv4.ip_forward=1" /etc/sysctl.conf 2>/dev/null; then
  echo "net.ipv4.ip_forward=1" | sudo tee -a /etc/sysctl.conf > /dev/null
  sudo sysctl -p > /dev/null 2>&1 || true
  echo "Enabled IP forwarding"
fi

# Allow www-data to run wg-quick via sudo without password
SUDOERS_WG="/etc/sudoers.d/pincerna-wg"
if [ ! -f "$SUDOERS_WG" ]; then
  echo "Setting up sudo permissions for VPN control..."
  sudo tee "$SUDOERS_WG" > /dev/null <<SUDOEOF
# Allow www-data to control WireGuard VPN
www-data ALL=(ALL) NOPASSWD: /usr/bin/wg-quick up wg0
www-data ALL=(ALL) NOPASSWD: /usr/bin/wg-quick down wg0
www-data ALL=(ALL) NOPASSWD: /usr/bin/wg show
SUDOEOF
  sudo chmod 440 "$SUDOERS_WG"
  echo "Sudo permissions configured"
fi

echo "WireGuard setup complete"

# =========================================
# 4. Set up Python environment
# =========================================
echo ""
echo "[4/7] Setting up Python environment"

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
  sudo "$VENV_PATH/bin/python" -m pip install --upgrade pip setuptools wheel || true
fi
if [ -f "$REQ_FILE" ]; then
  echo "Installing Python requirements from $REQ_FILE"
  sudo "$VENV_PATH/bin/python" -m pip install --no-cache-dir -r "$REQ_FILE" || true
fi
sudo chown -R www-data:www-data "$VENV_PATH" || true

API_LOG="$REPO_ROOT/api.log"
if [ ! -f "$API_LOG" ]; then
  sudo mkdir -p "$(dirname "$API_LOG")"
  sudo touch "$API_LOG"
fi
sudo chown www-data:www-data "$API_LOG" || true
sudo chmod 640 "$API_LOG" || true


sudo mkdir -p /var/log/pincerna || true
sudo chown www-data:www-data /var/log/pincerna || true
sudo chmod 750 /var/log/pincerna || true


ENV_FILE="/etc/default/pincerna"
if [ ! -f "$ENV_FILE" ]; then
  echo "Creating default environment file at $ENV_FILE"
  sudo tee "$ENV_FILE" > /dev/null <<EOL
# Pincerna environment configuration
# Fill in your credentials below:

# Google OAuth (required for sign-in)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Cloudflare Turnstile (required for bot protection)
TURNSTILE_SITEKEY=
TURNSTILE_SECRET=

# File storage root directory
FILES_ROOT=${FILES_ROOT}
EOL
  sudo chmod 640 "$ENV_FILE" || true
  sudo chown root:root "$ENV_FILE" || true
  echo ""
  echo "========================================="
  echo "IMPORTANT: Edit $ENV_FILE to add your credentials"
  echo "========================================="
  echo ""
else
  # Make sure FILES_ROOT is in the env file
  if ! grep -q "FILES_ROOT" "$ENV_FILE" 2>/dev/null; then
    echo "FILES_ROOT=${FILES_ROOT}" | sudo tee -a "$ENV_FILE" > /dev/null
  fi
fi

echo ""
echo "[5/7] Writing systemd service"
sudo tee "$SYSTEMD_UNIT_PATH" > /dev/null <<EOF
[Unit]
Description=Pincerna Flask API
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=${REPO_ROOT}
Environment=FLASK_ENV=production
EnvironmentFile=/etc/default/pincerna

ExecStart=${VENV_PATH}/bin/gunicorn -b 127.0.0.1:5002 services.api.app:app --workers 2 --chdir ${REPO_ROOT}
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload || true
echo "Enabling and starting pincerna service"
if sudo systemctl enable --now pincerna.service 2>/dev/null; then
  true
else
  
  sudo systemctl daemon-reload || true
  sudo systemctl enable pincerna.service || true
  sudo systemctl start pincerna.service || sudo systemctl restart pincerna.service || true
fi


# =========================================
# 6. Configure nginx
# =========================================
echo ""
echo "[6/7] Configuring nginx"

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

# =========================================
# 7. Deployment Complete
# =========================================
echo ""
echo "========================================="
echo "[7/7] Deployment Complete!"
echo "========================================="
echo ""
echo "Summary:"
echo "  - UI deployed to ${WWW_DIR}"
echo "  - File storage at ${FILES_ROOT}"
echo "  - WireGuard VPN configured"
echo "  - Backend service: pincerna.service"
echo ""
echo "Next steps:"
echo "  1. Edit /etc/default/pincerna with your credentials"
echo "  2. Edit /etc/wireguard/wg0.conf to add VPN peers"
echo "  3. Start VPN: sudo wg-quick up wg0"
echo "  4. Check service: sudo systemctl status pincerna"
echo ""
if [ -f "/etc/wireguard/publickey" ]; then
  echo "Your WireGuard server public key:"
  sudo cat /etc/wireguard/publickey
  echo ""
fi
echo "========================================="
