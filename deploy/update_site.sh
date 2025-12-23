#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$REPO_ROOT/services/ui"
WWW_DIR="/var/www/pincerna/cloud"
FILES_ROOT="/home/pincerna/files"
ENV_FILE="/etc/default/pincerna"
SYSTEMD_UNIT="/etc/systemd/system/pincerna.service"
NGINX_AVAILABLE="/etc/nginx/sites-available/cloud.emilvinod.com"
NGINX_ENABLED="/etc/nginx/sites-enabled/cloud.emilvinod.com"
VENV_PATH="$REPO_ROOT/venv"
WG_CONF="/etc/wireguard/wg0.conf"
WG_PRIVKEY="/etc/wireguard/privatekey"
WG_PUBKEY="/etc/wireguard/publickey"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' 




log_step() {
    echo -e "\n${BLUE}[$1]${NC} $2"
}

log_success() {
    echo -e "${GREEN}✓${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}⚠${NC} $1"
}

log_error() {
    echo -e "${RED}✗${NC} $1"
}


check_root() {
    if [ "$EUID" -ne 0 ]; then
        echo "This script must be run as root (use sudo)"
        exit 1
    fi
}


get_credential() {
    local var_name="$1"
    local prompt_text="$2"
    local current_value=""
    
    
    if [ -f "$ENV_FILE" ]; then
        current_value=$(grep "^${var_name}=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'" || true)
    fi
    
    
    if [ -z "$current_value" ]; then
        echo -en "${YELLOW}Enter ${prompt_text}: ${NC}"
        read -r current_value
    else
        echo -e "${GREEN}✓${NC} ${prompt_text}: [already configured]"
    fi
    
    echo "$current_value"
}




echo ""
echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}   Pincerna Complete Installer v2.0     ${NC}"
echo -e "${BLUE}=========================================${NC}"
echo ""

check_root




log_step "1/8" "Installing system dependencies"


PACKAGES="nginx python3 python3-venv python3-pip rsync wireguard wireguard-tools openssl"
NEED_INSTALL=""
for pkg in $PACKAGES; do
    if ! dpkg -l "$pkg" 2>/dev/null | grep -q "^ii"; then
        NEED_INSTALL="$NEED_INSTALL $pkg"
    fi
done

if [ -n "$NEED_INSTALL" ]; then
    apt-get update -qq
    for pkg in $NEED_INSTALL; do
        echo "Installing $pkg..."
        apt-get install -y "$pkg" >/dev/null 2>&1
    done
    log_success "Installed:$NEED_INSTALL"
else
    log_success "All dependencies already installed"
fi




log_step "2/8" "Checking credentials"

# Only create env file if it doesn't exist - NEVER overwrite existing credentials
if [ ! -f "$ENV_FILE" ]; then
    echo "Creating new credentials file at $ENV_FILE"
    echo "You will need to edit this file and add your keys manually."
    cat > "$ENV_FILE" <<EOL
# Pincerna Environment Configuration
# Edit this file to add your credentials

# Google OAuth (from console.cloud.google.com)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Cloudflare Turnstile (from dash.cloudflare.com -> Turnstile)
TURNSTILE_SITEKEY=
TURNSTILE_SECRET=

# File storage root
FILES_ROOT=${FILES_ROOT}
EOL
    chmod 640 "$ENV_FILE"
    log_warn "Created $ENV_FILE - you MUST edit it to add your credentials!"
    log_warn "Run: sudo nano $ENV_FILE"
else
    log_success "Credentials file exists at $ENV_FILE (not modified)"
    # Source existing values to check them
    . "$ENV_FILE" 2>/dev/null || true
fi

# Check if credentials are set
MISSING_CREDS=""
[ -z "$GOOGLE_CLIENT_ID" ] && MISSING_CREDS="$MISSING_CREDS GOOGLE_CLIENT_ID"
[ -z "$GOOGLE_CLIENT_SECRET" ] && MISSING_CREDS="$MISSING_CREDS GOOGLE_CLIENT_SECRET"
[ -z "$TURNSTILE_SITEKEY" ] && MISSING_CREDS="$MISSING_CREDS TURNSTILE_SITEKEY"
[ -z "$TURNSTILE_SECRET" ] && MISSING_CREDS="$MISSING_CREDS TURNSTILE_SECRET"

if [ -n "$MISSING_CREDS" ]; then
    log_warn "Missing credentials in $ENV_FILE:$MISSING_CREDS"
    log_warn "Edit $ENV_FILE to add them, then: sudo systemctl restart pincerna"
else
    log_success "All credentials found"
fi




log_step "3/8" "Setting up file storage"

mkdir -p "$FILES_ROOT"
chown www-data:www-data "$FILES_ROOT"
chmod 750 "$FILES_ROOT"
log_success "File storage ready at $FILES_ROOT"




log_step "4/8" "Configuring WireGuard VPN"


if [ ! -f "$WG_PRIVKEY" ]; then
    echo "Generating WireGuard keys..."
    mkdir -p /etc/wireguard
    wg genkey > "$WG_PRIVKEY"
    chmod 600 "$WG_PRIVKEY"
    cat "$WG_PRIVKEY" | wg pubkey > "$WG_PUBKEY"
    chmod 644 "$WG_PUBKEY"
    log_success "Generated new WireGuard keypair"
fi


if [ ! -f "$WG_CONF" ]; then
    PRIVKEY=$(cat "$WG_PRIVKEY")
    
    
    PRIMARY_IFACE=$(ip route | grep default | awk '{print $5}' | head -1)
    [ -z "$PRIMARY_IFACE" ] && PRIMARY_IFACE="eth0"
    
    cat > "$WG_CONF" <<WGEOF
[Interface]
PrivateKey = ${PRIVKEY}
Address = 10.0.0.1/24
ListenPort = 51820
PostUp = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o ${PRIMARY_IFACE} -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o ${PRIMARY_IFACE} -j MASQUERADE






WGEOF
    chmod 600 "$WG_CONF"
    log_success "Created WireGuard configuration"
else
    log_success "WireGuard config already exists"
fi


if ! grep -q "^net.ipv4.ip_forward=1" /etc/sysctl.conf 2>/dev/null; then
    echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf
fi
sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1
log_success "IP forwarding enabled"


SUDOERS_WG="/etc/sudoers.d/pincerna-wg"
cat > "$SUDOERS_WG" <<SUDOEOF

www-data ALL=(ALL) NOPASSWD: /usr/bin/wg-quick up wg0
www-data ALL=(ALL) NOPASSWD: /usr/bin/wg-quick down wg0
www-data ALL=(ALL) NOPASSWD: /usr/bin/wg show
www-data ALL=(ALL) NOPASSWD: /usr/bin/wg show wg0
SUDOEOF
chmod 440 "$SUDOERS_WG"
log_success "VPN sudo permissions configured"

# Enable wg0 on boot
systemctl enable wg-quick@wg0 >/dev/null 2>&1 || true

# Create first device config if no devices exist yet
PEERS_DIR="/etc/wireguard/peers"
mkdir -p "$PEERS_DIR"

if ! grep -q "^\[Peer\]" "$WG_CONF" 2>/dev/null; then
    echo ""
    echo -e "${YELLOW}No VPN devices configured yet.${NC}"
    echo -en "${YELLOW}Enter a name for your first device (e.g., phone, laptop) or press Enter to skip: ${NC}"
    read -r DEVICE_NAME
    
    if [ -n "$DEVICE_NAME" ]; then
        # Sanitize name
        DEVICE_NAME=$(echo "$DEVICE_NAME" | tr -cd '[:alnum:]_-')
        
        # Generate device keys
        DEVICE_PRIVKEY=$(wg genkey)
        DEVICE_PUBKEY=$(echo "$DEVICE_PRIVKEY" | wg pubkey)
        DEVICE_IP="10.0.0.2"
        
        # Get server info
        SERVER_PUBKEY=$(cat "$WG_PUBKEY")
        SERVER_IP=$(curl -s -4 ifconfig.me 2>/dev/null || curl -s -4 icanhazip.com 2>/dev/null || echo "YOUR_SERVER_IP")
        
        # Add device to server config
        cat >> "$WG_CONF" <<PEEREOF

# Device: ${DEVICE_NAME} (added $(date +%Y-%m-%d))
[Peer]
PublicKey = ${DEVICE_PUBKEY}
AllowedIPs = ${DEVICE_IP}/32
PEEREOF
        
        # Save device config file
        DEVICE_CONF="${PEERS_DIR}/${DEVICE_NAME}.conf"
        cat > "$DEVICE_CONF" <<DEVICEEOF
[Interface]
PrivateKey = ${DEVICE_PRIVKEY}
Address = ${DEVICE_IP}/24
DNS = 1.1.1.1, 8.8.8.8

[Peer]
PublicKey = ${SERVER_PUBKEY}
Endpoint = ${SERVER_IP}:51820
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
DEVICEEOF
        chmod 600 "$DEVICE_CONF"
        
        log_success "Created VPN config for '${DEVICE_NAME}'"
        log_success "Config saved to ${DEVICE_CONF}"
        
        # Store for later display
        CREATED_DEVICE="$DEVICE_NAME"
        CREATED_DEVICE_CONF="$DEVICE_CONF"
    else
        log_warn "Skipped - you can add devices later by re-running this script"
    fi
fi

# Start WireGuard if we have devices configured
if grep -q "^\[Peer\]" "$WG_CONF" 2>/dev/null; then
    wg-quick down wg0 >/dev/null 2>&1 || true
    wg-quick up wg0 >/dev/null 2>&1 || true
    log_success "WireGuard VPN started"
else
    log_warn "WireGuard ready but no devices configured yet"
fi




log_step "5/8" "Setting up Python environment"


if [ ! -d "$VENV_PATH" ]; then
    python3 -m venv "$VENV_PATH"
    log_success "Created Python virtual environment"
fi


"$VENV_PATH/bin/python" -m pip install --upgrade pip setuptools wheel -q
if [ -f "$REPO_ROOT/services/api/requirements.txt" ]; then
    "$VENV_PATH/bin/python" -m pip install -q --no-cache-dir -r "$REPO_ROOT/services/api/requirements.txt"
fi
chown -R www-data:www-data "$VENV_PATH"
log_success "Python dependencies installed"


mkdir -p /var/log/pincerna
chown www-data:www-data /var/log/pincerna
chmod 750 /var/log/pincerna
touch "$REPO_ROOT/api.log" 2>/dev/null || true
chown www-data:www-data "$REPO_ROOT/api.log" 2>/dev/null || true




log_step "6/8" "Deploying UI files"

if [ ! -d "$SRC_DIR" ]; then
    log_error "Source directory not found: $SRC_DIR"
    exit 1
fi

mkdir -p "$(dirname "$WWW_DIR")"
rsync -a --delete "$SRC_DIR/" "$WWW_DIR/"
chown -R www-data:www-data "$(dirname "$WWW_DIR")"
log_success "UI deployed to $WWW_DIR"




log_step "7/8" "Configuring services"


cat > "$SYSTEMD_UNIT" <<EOF
[Unit]
Description=Pincerna Flask API
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=${REPO_ROOT}
Environment=FLASK_ENV=production
EnvironmentFile=${ENV_FILE}
ExecStart=${VENV_PATH}/bin/gunicorn -b 127.0.0.1:5002 services.api.app:app --workers 2 --chdir ${REPO_ROOT}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF


SSLCERT="/etc/ssl/certs/cloud.emilvinod.com.crt"
SSLKEY="/etc/ssl/private/cloud.emilvinod.com.key"


if [ ! -f "$SSLCERT" ] || [ ! -f "$SSLKEY" ]; then
    echo "Creating self-signed SSL certificate..."
    mkdir -p /etc/ssl/private /etc/ssl/certs
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "$SSLKEY" -out "$SSLCERT" \
        -subj "/CN=cloud.emilvinod.com" >/dev/null 2>&1
    chmod 640 "$SSLKEY"
    chmod 644 "$SSLCERT"
    log_success "Created self-signed SSL certificate"
else
    log_success "SSL certificates already exist"
fi

if [ -f "$REPO_ROOT/nginx/pincerna_auth.conf.example" ]; then
    cp "$REPO_ROOT/nginx/pincerna_auth.conf.example" "$NGINX_AVAILABLE"
    ln -sf "$NGINX_AVAILABLE" "$NGINX_ENABLED"
fi

# Remove default nginx site and any configs referencing snakeoil certs
rm -f /etc/nginx/sites-enabled/default 2>/dev/null
find /etc/nginx/sites-enabled -xtype l -delete 2>/dev/null || true

# Disable any config files that reference snakeoil (but not our site)
for conf in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
    [ -f "$conf" ] || continue
    [ "$conf" = "$NGINX_ENABLED" ] && continue
    if grep -q "snakeoil" "$conf" 2>/dev/null; then
        log_warn "Disabling $conf (references missing snakeoil certs)"
        rm -f "$conf" 2>/dev/null || mv "$conf" "${conf}.disabled" 2>/dev/null || true
    fi
done

mkdir -p /var/log/nginx
chown root:adm /var/log/nginx
chmod 750 /var/log/nginx

log_success "Services configured"




log_step "8/8" "Starting all services"


systemctl daemon-reload


systemctl enable pincerna.service >/dev/null 2>&1
systemctl restart pincerna.service
sleep 2


if systemctl is-active --quiet pincerna.service; then
    log_success "Pincerna backend service started"
else
    log_error "Pincerna service failed to start!"
    systemctl status pincerna.service --no-pager || true
fi


if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx || systemctl restart nginx
    log_success "Nginx reloaded"
else
    log_error "Nginx configuration test failed:"
    nginx -t
fi




echo ""
echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}    Installation Complete!              ${NC}"
echo -e "${GREEN}=========================================${NC}"
echo ""
echo "Summary:"
echo -e "  ${GREEN}✓${NC} UI:        $WWW_DIR"
echo -e "  ${GREEN}✓${NC} Files:     $FILES_ROOT"
echo -e "  ${GREEN}✓${NC} Backend:   pincerna.service (port 5002)"
echo -e "  ${GREEN}✓${NC} VPN:       WireGuard on wg0"
echo ""


if [ -f "$WG_PUBKEY" ]; then
    # If we just created a device, show its config
    if [ -n "${CREATED_DEVICE:-}" ] && [ -f "${CREATED_DEVICE_CONF:-}" ]; then
        echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
        echo -e "${GREEN}VPN Configuration for '${CREATED_DEVICE}':${NC}"
        echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
        echo ""
        cat "$CREATED_DEVICE_CONF"
        echo ""
        echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
        echo ""
        echo -e "${GREEN}To connect:${NC}"
        echo "  1. Install the WireGuard app on your device"
        echo "  2. Copy the config above (or import ${CREATED_DEVICE_CONF})"
        echo "  3. Activate the VPN in the app"
        echo ""
        
        # Show QR code if qrencode is available
        if command -v qrencode >/dev/null 2>&1; then
            echo -e "${GREEN}Or scan this QR code with the WireGuard app:${NC}"
            echo ""
            qrencode -t ansiutf8 < "$CREATED_DEVICE_CONF"
            echo ""
        else
            echo -e "${YELLOW}Tip: Install qrencode to generate a QR code:${NC}"
            echo "  sudo apt install qrencode"
            echo "  qrencode -t ansiutf8 < ${CREATED_DEVICE_CONF}"
            echo ""
        fi
    else
        echo -e "${BLUE}WireGuard Server Public Key:${NC}"
        echo -e "${YELLOW}$(cat "$WG_PUBKEY")${NC}"
        echo ""
        echo -e "${YELLOW}No VPN device was configured.${NC}"
        echo "To add a device later, re-run this script."
        echo ""
    fi
fi


echo "Service Status:"
if systemctl is-active --quiet pincerna.service; then
    echo -e "  ${GREEN}●${NC} pincerna.service: running"
else
    echo -e "  ${RED}●${NC} pincerna.service: stopped"
fi

if systemctl is-active --quiet nginx; then
    echo -e "  ${GREEN}●${NC} nginx: running"
else
    echo -e "  ${RED}●${NC} nginx: stopped"
fi

if ip link show wg0 >/dev/null 2>&1; then
    echo -e "  ${GREEN}●${NC} WireGuard (wg0): up"
else
    echo -e "  ${YELLOW}●${NC} WireGuard (wg0): down (re-run this script to add a device)"
fi

echo ""
echo -e "Access your dashboard at: ${BLUE}https://cloud.emilvinod.com/cloud${NC}"
echo ""
