#!/usr/bin/env bash
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPDATE_SCRIPT="$REPO_ROOT/deploy/update_site.sh"

GREEN='\033[0;32m'
BLUE='\033[38;2;255;122;0m'
NC='\033[0m'

echo ""
echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}  Pincerna: Pull & Update${NC}"
echo -e "${BLUE}=========================================${NC}"
echo ""

if [ "$EUID" -ne 0 ]; then
    echo "This script must be run as root (use sudo)"
    exit 1
fi

echo -e "${GREEN}[1/2]${NC} Pulling latest code from GitHub..."
cd "$REPO_ROOT"
git pull

echo ""

echo -e "${GREEN}[2/2]${NC} Running update script..."
if [ -f "$UPDATE_SCRIPT" ]; then
    bash "$UPDATE_SCRIPT"
else
    echo "ERROR: Update script not found: $UPDATE_SCRIPT"
    exit 1
fi

echo ""
echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}  Update Complete!${NC}"
echo -e "${GREEN}=========================================${NC}"
echo ""
