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

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[38;2;255;122;0m'
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
echo -ne "${BLUE}"
cat <<'BANNER'
                        +++++++++++++           
             .++++++++++++++++++++       
         +=. :++++++++++++++++++++     
     +++++=. :++++++++++++++++++++   
    ++++++++-..-+++++++++++++++++++  
 +++++++++++-  =++++++++++++++++++ 
+++++++++++++:..=+++++++++++++++++
++++++++++++++=. .++++++++++++++++
+++++++++++++++... .++++++++++++++
+++++++++++++++..+=. :++++++++++++
+++++++++++++++..+++=..-++++++++++
+++++++++++++++.:+++++=..+++++++++
+++++++++++++++.:+++++++=.:+++++++
 +++++++++++++++.:++++++++++.=++++ 
    ++++++++++++++.-+++++++++++:-++  
     +++++++++++++:-++++++++++++++   
         +++++++++++:=++++++++++++     
             +++++++++.-++++++++++       
                    *++++++++++++++           
BANNER
echo -ne "${NC}"
echo -e "${BLUE}    Pincerna Installer v1.0-beta    ${NC}"
echo ""

check_root




log_step "1/7" "Installing system dependencies"


PACKAGES="nginx python3 python3-venv python3-pip rsync curl openssl nmap"
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




log_step "2/7" "Checking credentials"

if [ ! -f "$ENV_FILE" ]; then
    echo "Creating new credentials file at $ENV_FILE"
    echo "You will need to edit this file and add your keys manually."
    
    JWT_SECRET_GENERATED=$(openssl rand -hex 32)
    
    cat > "$ENV_FILE" <<EOL
# Pincerna Environment Configuration
# Edit this file to add your credentials

# JWT Secret (auto-generated, do not share)
JWT_SECRET=${JWT_SECRET_GENERATED}

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
    . "$ENV_FILE" 2>/dev/null || true
    
    if [ -z "${JWT_SECRET:-}" ]; then
        JWT_SECRET_GENERATED=$(openssl rand -hex 32)
        echo "" >> "$ENV_FILE"
        echo "# JWT Secret (auto-generated)" >> "$ENV_FILE"
        echo "JWT_SECRET=${JWT_SECRET_GENERATED}" >> "$ENV_FILE"
        log_success "Added JWT_SECRET to existing config"
    fi
fi

MISSING_CREDS=""
[ -z "${GOOGLE_CLIENT_ID:-}" ] && MISSING_CREDS="$MISSING_CREDS GOOGLE_CLIENT_ID"
[ -z "${GOOGLE_CLIENT_SECRET:-}" ] && MISSING_CREDS="$MISSING_CREDS GOOGLE_CLIENT_SECRET"
[ -z "${TURNSTILE_SITEKEY:-}" ] && MISSING_CREDS="$MISSING_CREDS TURNSTILE_SITEKEY"
[ -z "${TURNSTILE_SECRET:-}" ] && MISSING_CREDS="$MISSING_CREDS TURNSTILE_SECRET"

if [ -n "$MISSING_CREDS" ]; then
    log_warn "Missing credentials in $ENV_FILE:$MISSING_CREDS"
    log_warn "Edit $ENV_FILE to add them, then: sudo systemctl restart pincerna"
else
    log_success "All credentials found"
fi




log_step "3/7" "Setting up file storage"

mkdir -p "$FILES_ROOT"
chown www-data:www-data "$FILES_ROOT"
chmod 750 "$FILES_ROOT"
log_success "File storage ready at $FILES_ROOT"


log_step "4/7" "Setting up Python environment"


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




log_step "5/7" "Deploying UI files"

if [ ! -d "$SRC_DIR" ]; then
    log_error "Source directory not found: $SRC_DIR"
    exit 1
fi

mkdir -p "$(dirname "$WWW_DIR")"
rsync -a --delete "$SRC_DIR/" "$WWW_DIR/"
chown -R www-data:www-data "$(dirname "$WWW_DIR")"
log_success "UI deployed to $WWW_DIR"




log_step "6/7" "Configuring services"


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

rm -f /etc/nginx/sites-enabled/default 2>/dev/null
find /etc/nginx/sites-enabled -xtype l -delete 2>/dev/null || true

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




log_step "7/7" "Starting all services"


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
echo ""

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

echo ""
echo -e "Access your dashboard at: ${BLUE}https://cloud.emilvinod.com/cloud${NC}"
echo ""
