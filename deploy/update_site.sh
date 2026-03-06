#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$REPO_ROOT/services/ui"
WWW_DIR="/var/www/pincerna/cloud"
FILES_ROOT="/mnt"
ENV_FILE="/etc/default/pincerna"
SYSTEMD_UNIT="/etc/systemd/system/pincerna.service"
NGINX_AVAILABLE="/etc/nginx/sites-available/cloud.emilvinod.com"
NGINX_ENABLED="/etc/nginx/sites-enabled/cloud.emilvinod.com"
RUST_BINARY="$REPO_ROOT/services/api/pincerna_api"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[38;2;255;122;0m'
NC='\033[0m' 




log_step() {
    echo -e "\n${BLUE}[$1]${NC} ${2:-}"
}

log_success() {
    echo -e "${GREEN}âœ“${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}âš ${NC} $1"
}

log_error() {
    echo -e "${RED}âœ—${NC} $1"
}


# Simple spinner functions for long-running steps
_spinner_pid=0
spinner_start() {
    local msg="$1"
    ( while :; do for c in '|/-\\'; do printf "\r%s %s" "${c}" "$msg"; sleep 0.18; done; done ) &
    _spinner_pid=$!
    disown $_spinner_pid 2>/dev/null || true
}

spinner_stop() {
    if [ "$_spinner_pid" -ne 0 ] 2>/dev/null; then
        kill "$_spinner_pid" 2>/dev/null || true
        wait "$_spinner_pid" 2>/dev/null || true
        _spinner_pid=0
        printf "\r"
    fi
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
        echo -e "${GREEN}âœ“${NC} ${prompt_text}: [already configured]"
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
++++++++++++++:..=+++++++++++++++++
+++++++++++++++=. .++++++++++++++++
++++++++++++++++... .++++++++++++++
++++++++++++++++..+=. :++++++++++++
++++++++++++++++..+++=..-++++++++++
++++++++++++++++.:+++++=..+++++++++
++++++++++++++++.:+++++++=.:+++++++
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




log_step "1/8" "Installing system dependencies"


REQ_FILE="$REPO_ROOT/services/api/requirements.system.txt"
if [ ! -f "$REQ_FILE" ]; then
    log_error "Missing $REQ_FILE. Please create it with a list of required system packages."
    exit 1
fi

PACKAGES="$(grep -vE '^#|^$' "$REQ_FILE" | xargs)"
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

# Install Rust toolchain if not present
if ! command -v cargo &>/dev/null; then
    log_step "1.1/8" "Installing Rust toolchain"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
    . "$HOME/.cargo/env"
    log_success "Rust toolchain installed"
else
    log_success "Rust toolchain already installed"
fi




log_step "2/8" "Checking credentials"

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
    # Update .env with new FILES_ROOT
    if grep -q "^FILES_ROOT=" "$ENV_FILE" 2>/dev/null; then
        sed -i "s|^FILES_ROOT=.*|FILES_ROOT=/mnt|" "$ENV_FILE"
    else
        echo "FILES_ROOT=/mnt" >> "$ENV_FILE"
    fi
    
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




log_step "3/8" "Setting up file storage"

mkdir -p "$FILES_ROOT"
if [ "$FILES_ROOT" != "/" ]; then
    chown www-data:www-data "$FILES_ROOT"
    chmod 750 "$FILES_ROOT"
fi
log_success "File storage ready at $FILES_ROOT"


# Attempt to auto-detect removable/unmounted partitions and mount them under FILES_ROOT
detect_and_mount_drives() {
    log_step "3.1/8" "Auto-detecting unmounted drives and mounting under $FILES_ROOT"

    # List block partitions (no loop devices), show NAME,FSTYPE,UUID,LABEL,MOUNTPOINT
    while IFS= read -r line; do
        name=$(echo "$line" | awk '{print $1}')
        fstype=$(echo "$line" | awk '{print $2}')
        uuid=$(echo "$line" | awk '{print $3}')
        label=$(echo "$line" | awk '{print $4}')
        mnt=$(echo "$line" | awk '{print $5}')

        # Skip already mounted or empty names
        [ -z "$name" ] && continue
        [ "$mnt" != "-" ] && continue

        # Only consider sd* and nvme partitions
        case "$name" in
            /dev/sd*|/dev/nvme*|/dev/hd*) ;;
            *) continue ;;
        esac

        # Choose a mount dir name: label or basename
        dirname="$label"
        if [ -z "$dirname" ] || [ "$dirname" = "-" ]; then
            dirname=$(basename "$name")
        fi

        mountpoint="/mnt/$dirname"
        mkdir -p "$mountpoint"
        chown www-data:www-data "$mountpoint" || true

        # Try mounting with appropriate driver
        if [ "$fstype" = "ntfs" ] || [ "$fstype" = "ntfs3" ]; then
            mount_cmd=(ntfs-3g "$name" "$mountpoint")
        elif [ "$fstype" = "exfat" ]; then
            mount_cmd=(mount -t exfat "$name" "$mountpoint")
        else
            mount_cmd=(mount "$name" "$mountpoint")
        fi

        if "${mount_cmd[@]}"; then
            log_success "Mounted $name -> $mountpoint"
            # Add a simple fstab entry for persistence if UUID is available
            if [ -n "$uuid" ] && [ "$uuid" != "-" ]; then
                # Check if already in fstab
                if ! grep -q "$uuid" /etc/fstab 2>/dev/null; then
                    fstype_entry="$fstype"
                    if [ "$fstype" = "ntfs" ] || [ "$fstype" = "ntfs3" ]; then
                        opts="defaults,uid=www-data,gid=www-data"
                        fstype_entry="ntfs-3g"
                    elif [ "$fstype" = "exfat" ]; then
                        opts="defaults"
                        fstype_entry="exfat"
                    else
                        opts="defaults"
                    fi
                    echo "UUID=$uuid    $mountpoint    $fstype_entry    $opts    0    2" >> /etc/fstab
                    log_success "Added fstab entry for $name"
                fi
            fi
        else
            log_warn "Failed to mount $name to $mountpoint"
        fi
    done < <(lsblk -plno NAME,FSTYPE,UUID,LABEL,MOUNTPOINT | awk '{ if($1!="") print $0 }')
}

detect_and_mount_drives || true


log_step "4/8" "Building Rust backend"

if [ -f "$REPO_ROOT/deploy/build_backend.sh" ]; then
    bash "$REPO_ROOT/deploy/build_backend.sh"
else
    log_error "Missing build_backend.sh script. Please add it to deploy/ folder."
    exit 1
fi

if [ ! -f "$RUST_BINARY" ]; then
    log_error "Build failed: $RUST_BINARY not found"
    exit 1
fi

# Set permissions and log directory
mkdir -p /var/log/pincerna
chown www-data:www-data /var/log/pincerna
chmod 750 /var/log/pincerna
touch "$REPO_ROOT/api.log" 2>/dev/null || true
chown www-data:www-data "$REPO_ROOT/api.log" 2>/dev/null || true




log_step "5/8" "Deploying UI files"

if [ ! -d "$SRC_DIR" ]; then
    log_error "Source directory not found: $SRC_DIR"
    exit 1
fi

mkdir -p "$(dirname "$WWW_DIR")"
rsync -a --delete "$SRC_DIR/" "$WWW_DIR/"
chown -R www-data:www-data "$(dirname "$WWW_DIR")"
log_success "UI deployed to $WWW_DIR"




log_step "6/8" "Configuring services"


cat > "$SYSTEMD_UNIT" <<EOF
[Unit]
Description=Pincerna Rust API Backend
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=${REPO_ROOT}
EnvironmentFile=${ENV_FILE}
ExecStart=${RUST_BINARY}
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




log_step "7/8" "Starting all services"


systemctl daemon-reload


systemctl enable pincerna.service >/dev/null 2>&1
if ! systemctl is-active --quiet pincerna.service; then
    systemctl start pincerna.service
    sleep 2
fi


if systemctl is-active --quiet pincerna.service; then
    log_success "Pincerna backend service enabled"
else
    log_warn "Pincerna service not running (will restart at end)"
fi


if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx || systemctl restart nginx
    log_success "Nginx reloaded"
else
    log_error "Nginx configuration test failed:"
    nginx -t
fi


log_step "8/8" "Restarting services"
if systemctl restart pincerna.service; then
    log_success "Pincerna backend restarted"
else
    log_error "Failed to restart pincerna"
fi

if systemctl restart nginx; then
    log_success "Nginx restarted"
else
    log_error "Failed to restart nginx"
fi




echo ""
echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}    Installation Complete!              ${NC}"
echo -e "${GREEN}=========================================${NC}"
echo ""
echo "Summary:"
echo -e "  ${GREEN}âœ“${NC} UI:        $WWW_DIR"
echo -e "  ${GREEN}âœ“${NC} Files:     $FILES_ROOT"
echo -e "  ${GREEN}âœ“${NC} Backend:   pincerna.service (Rust binary, port 5002)"
echo ""

echo "Service Status:"
if systemctl is-active --quiet pincerna.service; then
    echo -e "  ${GREEN}â—${NC} pincerna.service: running"
else
    echo -e "  ${RED}â—${NC} pincerna.service: stopped"
fi

if systemctl is-active --quiet nginx; then
    echo -e "  ${GREEN}â—${NC} nginx: running"
else
    echo -e "  ${RED}â—${NC} nginx: stopped"
fi

echo ""
echo -e "Access your dashboard at: ${BLUE}https://cloud.emilvinod.com/cloud${NC}"
echo ""
