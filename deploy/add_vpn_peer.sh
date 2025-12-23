#!/usr/bin/env bash
set -euo pipefail

# Pincerna VPN Peer Manager
# Usage: sudo ./add_vpn_peer.sh [peer_name]

WG_CONF="/etc/wireguard/wg0.conf"
WG_PUBKEY="/etc/wireguard/publickey"
PEERS_DIR="/etc/wireguard/peers"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Check root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}This script must be run as root (use sudo)${NC}"
    exit 1
fi

# Check if WireGuard is configured
if [ ! -f "$WG_CONF" ]; then
    echo -e "${RED}WireGuard not configured. Run update_site.sh first.${NC}"
    exit 1
fi

# Get peer name
PEER_NAME="${1:-}"
if [ -z "$PEER_NAME" ]; then
    echo -en "${YELLOW}Enter a name for this peer (e.g., phone, laptop): ${NC}"
    read -r PEER_NAME
fi

if [ -z "$PEER_NAME" ]; then
    echo -e "${RED}Peer name required${NC}"
    exit 1
fi

# Sanitize peer name
PEER_NAME=$(echo "$PEER_NAME" | tr -cd '[:alnum:]_-')

# Create peers directory
mkdir -p "$PEERS_DIR"

# Find next available IP
LAST_IP=$(grep -oP 'AllowedIPs\s*=\s*10\.0\.0\.\K[0-9]+' "$WG_CONF" 2>/dev/null | sort -n | tail -1 || echo "1")
NEXT_IP=$((LAST_IP + 1))

if [ "$NEXT_IP" -gt 254 ]; then
    echo -e "${RED}No more IPs available in 10.0.0.0/24 range${NC}"
    exit 1
fi

PEER_IP="10.0.0.${NEXT_IP}"

# Generate peer keys
PEER_PRIVKEY=$(wg genkey)
PEER_PUBKEY=$(echo "$PEER_PRIVKEY" | wg pubkey)

# Get server info
SERVER_PUBKEY=$(cat "$WG_PUBKEY")
SERVER_IP=$(curl -s -4 ifconfig.me 2>/dev/null || curl -s -4 icanhazip.com 2>/dev/null || echo "YOUR_SERVER_IP")

# Add peer to server config
cat >> "$WG_CONF" <<EOF

# Peer: ${PEER_NAME} (added $(date +%Y-%m-%d))
[Peer]
PublicKey = ${PEER_PUBKEY}
AllowedIPs = ${PEER_IP}/32
EOF

echo -e "${GREEN}✓${NC} Added peer to server config"

# Save peer config file
PEER_CONF="${PEERS_DIR}/${PEER_NAME}.conf"
cat > "$PEER_CONF" <<EOF
[Interface]
PrivateKey = ${PEER_PRIVKEY}
Address = ${PEER_IP}/24
DNS = 1.1.1.1, 8.8.8.8

[Peer]
PublicKey = ${SERVER_PUBKEY}
Endpoint = ${SERVER_IP}:51820
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
EOF

chmod 600 "$PEER_CONF"
echo -e "${GREEN}✓${NC} Saved peer config to ${PEER_CONF}"

# Reload WireGuard
if ip link show wg0 >/dev/null 2>&1; then
    wg-quick down wg0 >/dev/null 2>&1 || true
fi
wg-quick up wg0 >/dev/null 2>&1
echo -e "${GREEN}✓${NC} WireGuard restarted"

# Generate QR code if qrencode is available
echo ""
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}Client configuration for '${PEER_NAME}':${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo ""
cat "$PEER_CONF"
echo ""
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"

if command -v qrencode >/dev/null 2>&1; then
    echo ""
    echo -e "${GREEN}Scan this QR code with the WireGuard app:${NC}"
    echo ""
    qrencode -t ansiutf8 < "$PEER_CONF"
else
    echo ""
    echo -e "${YELLOW}Tip: Install qrencode for QR code generation:${NC}"
    echo "  sudo apt install qrencode"
    echo "  Then run: qrencode -t ansiutf8 < ${PEER_CONF}"
fi

echo ""
echo -e "${GREEN}Done!${NC} Import the config above into your WireGuard client app."
echo ""
