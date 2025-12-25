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




log_step "1/7" "Installing system dependencies"


PACKAGES="nginx python3 python3-venv python3-pip rsync curl openssl nmap ntfs-3g ffmpeg"
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


# Attempt to auto-detect removable/unmounted partitions and mount them under FILES_ROOT
detect_and_mount_drives() {
    log_step "3.1/7" "Auto-detecting unmounted drives and mounting under $FILES_ROOT"

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

        mountpoint="$FILES_ROOT/$dirname"
        mkdir -p "$mountpoint"
        chown www-data:www-data "$mountpoint" || true

        # Try mounting with appropriate driver
        if [ "$fstype" = "ntfs" ] || [ "$fstype" = "ntfs3" ]; then
            mount_cmd=(ntfs-3g "$name" "$mountpoint")
        else
            mount_cmd=(mount "$name" "$mountpoint")
        fi

        if "${mount_cmd[@]}" >/dev/null 2>&1; then
            log_success "Mounted $name -> $mountpoint"
            # Add a simple fstab entry for persistence if UUID is available
            if [ -n "$uuid" ] && [ "$uuid" != "-" ]; then
                # Check if already in fstab
                if ! grep -q "$uuid" /etc/fstab 2>/dev/null; then
                    fstype_entry="$fstype"
                    if [ "$fstype" = "ntfs" ] || [ "$fstype" = "ntfs3" ]; then
                        opts="defaults,uid=www-data,gid=www-data"
                        fstype_entry="ntfs-3g"
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


log_step "7.1/7" "Indexing video files and generating thumbnails"

VID_EXTS='-iname *.mp4 -o -iname *.mkv -o -iname *.mov -o -iname *.avi -o -iname *.webm -o -iname *.m4v -o -iname *.mpg -o -iname *.mpeg -o -iname *.ts -o -iname *.flv'
thumbs_dir="$FILES_ROOT/.thumbs"
manifest="$FILES_ROOT/.video_index.json"
mkdir -p "$thumbs_dir"

mapfile -t videos < <(find "$FILES_ROOT" -type f \( $VID_EXTS \) 2>/dev/null || true)
total=${#videos[@]}
if [ "$total" -eq 0 ]; then
    log_warn "No video files found under $FILES_ROOT"
else
    echo "Found $total video(s). Generating thumbnails..."
    count=0
    for f in "${videos[@]}"; do
        count=$((count+1))
        base=$(basename "$f")
        h=$(printf '%s' "$f" | md5sum | awk '{print $1}')
        thumb="$thumbs_dir/${h}.jpg"
        if [ ! -f "$thumb" ]; then
            # try to generate thumbnail (best-effort)
            ffmpeg -y -ss 5 -i "$f" -frames:v 1 -q:v 2 "$thumb" >/dev/null 2>&1 || true
        fi
        pct=$((count*100/total))
        # simple progress bar
        filled=$((pct/2))
        empty=$((50-filled))
        printf "\r[%s%s] %d/%d %s" "$(printf '%0.s#' $(seq 1 $filled))" "$(printf '%0.s-' $(seq 1 $empty))" "$count" "$total" "$base"
    done
    echo

    # write manifest
    echo '[' > "$manifest"
    first=1
    for f in "${videos[@]}"; do
        if [ "$first" -eq 1 ]; then first=0; else echo ',' >> "$manifest"; fi
        size=$(stat -c%s "$f" 2>/dev/null || echo 0)
        mtime=$(date -r "$f" --iso-8601=seconds 2>/dev/null || echo "")
        rel="/$(echo "$f" | sed "s#^$FILES_ROOT/##")"
        h=$(printf '%s' "$f" | md5sum | awk '{print $1}')
        thumb_rel="/cloud/api/thumbnail_file?h=${h}"
        # escape JSON strings
        name_esc=$(printf '%s' "$(basename "$f")" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip()))')
        rel_esc=$(printf '%s' "$rel" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip()))')
        mtime_esc=$(printf '%s' "$mtime" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip()))')
        thumb_esc=$(printf '%s' "$thumb_rel" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip()))')
        printf '{"name":%s,"path":%s,"size":%s,"mtime":%s,"thumbnail":%s}' "$name_esc" "$rel_esc" "$size" "$mtime_esc" "$thumb_esc" >> "$manifest"
    done
    echo ']' >> "$manifest"
    log_success "Video manifest written to $manifest"
fi

# restart backend so it picks up thumbnails/index
systemctl restart pincerna.service || true




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