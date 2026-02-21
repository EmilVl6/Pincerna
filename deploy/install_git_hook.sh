#!/usr/bin/env bash
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_TEMPLATE="$REPO_ROOT/deploy/post-merge.hook"
HOOK_DEST="$REPO_ROOT/.git/hooks/post-merge"

GREEN='\033[0;32m'
BLUE='\033[38;2;255;122;0m'
NC='\033[0m'

echo ""
echo -e "${BLUE}Installing Git Post-Merge Hook${NC}"
echo ""

if [ "$EUID" -ne 0 ]; then
    echo "This script must be run as root (use sudo)"
    exit 1
fi

if [ -f "$HOOK_TEMPLATE" ]; then
    cp "$HOOK_TEMPLATE" "$HOOK_DEST"
    chmod +x "$HOOK_DEST"
    echo -e "${GREEN}Installed post-merge hook: $HOOK_DEST${NC}"
    echo -e "${GREEN}Hook is now executable${NC}"
    echo ""
    echo "Now when you run 'git pull' (as root), it will automatically run update_site.sh"
    echo ""
else
    echo "ERROR: Hook template not found: $HOOK_TEMPLATE"
    exit 1
fi