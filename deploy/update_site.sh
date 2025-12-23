#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$REPO_ROOT/services/ui"
WWW_DIR="/var/www/pincerna/cloud"
FILES_ROOT="/opt/pincerna/files"
ENV_FILE="/etc/default/pincerna"
SYSTEMD_UNIT="/etc/systemd/system/pincerna.service"
NGINX_CONF="$REPO_ROOT/nginx/nginx.conf"
NGINX_AVAILABLE="/etc/nginx/sites-available/cloud.emilvinod.com"
NGINX_ENABLED="/etc/nginx/sites-enabled/cloud.emilvinod.com"
VENV_PATH="/opt/pincerna/.venv"
LOG_DIR="/var/log/pincerna"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[38;5;208m'
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


echo ""
echo -e "${BLUE}      ++++++++++     ${NC}"
echo -e "${BLUE}  ++.:++++++++++++  ${NC}"
echo -e "${BLUE} ++++=.-+++++++++++ ${NC}"
echo -e "${BLUE}+++++++-.=++++++++++${NC}"
echo -e "${BLUE}+++++++++..=++++++++${NC}"
echo -e "${BLUE}+++++++++.=::+++++++${NC}"
echo -e "${BLUE}+++++++++.=++:-+++++${NC}"
echo -e "${BLUE}+++++++++.=++++-=+++${NC}"
echo -e "${BLUE} ++++++++:++++++==+ ${NC}"
echo -e "${BLUE}  +++++++-++++++++  ${NC}"
echo -e "${BLUE}     ++++=+++++     ${NC}"
echo ""
echo -e "       ${BLUE}Pincerna Installer v2.1${NC}"
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
    mkdir -p "$(dirname "$ENV_FILE")"
    JWT_SECRET_GENERATED=$(openssl rand -hex 32)
    
    cat > "$ENV_FILE" <<EOL
JWT_SECRET=${JWT_SECRET_GENERATED}
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
TURNSTILE_SITEKEY=
TURNSTILE_SECRET=
FILES_ROOT=${FILES_ROOT}
EOL
    chmod 640 "$ENV_FILE"
    log_warn "Created $ENV_FILE - edit it to add your credentials"
else
    log_success "Credentials file exists"
    . "$ENV_FILE" 2>/dev/null || true
    
    if [ -z "${JWT_SECRET:-}" ]; then
        JWT_SECRET_GENERATED=$(openssl rand -hex 32)
        echo "JWT_SECRET=${JWT_SECRET_GENERATED}" >> "$ENV_FILE"
        log_success "Added JWT_SECRET"
    fi
fi

MISSING_CREDS=""
[ -z "${GOOGLE_CLIENT_ID:-}" ] && MISSING_CREDS="$MISSING_CREDS GOOGLE_CLIENT_ID"
[ -z "${GOOGLE_CLIENT_SECRET:-}" ] && MISSING_CREDS="$MISSING_CREDS GOOGLE_CLIENT_SECRET"
[ -z "${TURNSTILE_SITEKEY:-}" ] && MISSING_CREDS="$MISSING_CREDS TURNSTILE_SITEKEY"
[ -z "${TURNSTILE_SECRET:-}" ] && MISSING_CREDS="$MISSING_CREDS TURNSTILE_SECRET"

if [ -n "$MISSING_CREDS" ]; then
    log_warn "Missing:$MISSING_CREDS"
else
    log_success "All credentials found"
fi




log_step "3/7" "Setting up file storage"

mkdir -p "$FILES_ROOT"
chown root:www-data "$FILES_ROOT"
chmod 750 "$FILES_ROOT"
log_success "File storage ready at $FILES_ROOT"


log_step "4/7" "Setting up Python environment"

mkdir -p "$(dirname "$VENV_PATH")"
if [ ! -d "$VENV_PATH" ]; then
    python3 -m venv "$VENV_PATH"
    log_success "Created virtual environment"
fi

"$VENV_PATH/bin/pip" install --upgrade pip -q
"$VENV_PATH/bin/pip" install -q --no-cache-dir -r "$REPO_ROOT/services/api/requirements.txt"
log_success "Python dependencies installed"

mkdir -p "$LOG_DIR"
chown root:www-data "$LOG_DIR"
chmod 750 "$LOG_DIR"




log_step "5/7" "Deploying UI files"

mkdir -p "$WWW_DIR"
rsync -a --delete "$SRC_DIR/" "$WWW_DIR/"
chown -R www-data:www-data "$(dirname "$WWW_DIR")"
log_success "UI deployed to $WWW_DIR"




log_step "6/7" "Configuring services"

cp "$REPO_ROOT/deploy/pincerna.service" "$SYSTEMD_UNIT"

if [ -f "$NGINX_CONF" ]; then
    cp "$NGINX_CONF" "$NGINX_AVAILABLE"
    ln -sf "$NGINX_AVAILABLE" "$NGINX_ENABLED"
fi

rm -f /etc/nginx/sites-enabled/default 2>/dev/null

log_success "Services configured"




log_step "7/7" "Starting all services"

systemctl daemon-reload
systemctl enable pincerna.service >/dev/null 2>&1
systemctl restart pincerna.service
sleep 2

if systemctl is-active --quiet pincerna.service; then
    log_success "Pincerna service started"
else
    log_error "Pincerna service failed!"
    systemctl status pincerna.service --no-pager || true
fi

if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx || systemctl restart nginx
    log_success "Nginx reloaded"
else
    log_error "Nginx config failed"
    nginx -t
fi


echo ""
echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}    Installation Complete!              ${NC}"
echo -e "${GREEN}=========================================${NC}"
echo ""
echo -e "UI:      ${BLUE}$WWW_DIR${NC}"
echo -e "Files:   ${BLUE}$FILES_ROOT${NC}"
echo -e "Logs:    ${BLUE}$LOG_DIR${NC}"
echo -e "URL:     ${BLUE}https://cloud.emilvinod.com/cloud${NC}"
echo ""
