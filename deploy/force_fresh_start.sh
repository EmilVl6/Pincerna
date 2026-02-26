#!/bin/bash

echo "========================================="
echo "Force Fresh Video Re-indexing"
echo "========================================="
echo ""

echo "1. Stopping pincerna service..."
systemctl stop pincerna

echo "2. Clearing video index, thumbnails, and preview clips..."
rm -f /mnt/.video_index.json
rm -f /mnt/.video_index.ts
rm -rf /mnt/.thumbs/*
rm -rf /mnt/.previews/*

echo "3. Clearing Python cache..."
find /opt/pincerna -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
find /opt/pincerna -type f -name "*.pyc" -delete 2>/dev/null || true

echo "4. Pulling latest code from GitHub..."
cd /opt/pincerna
git fetch origin
git reset --hard origin/main

echo "5. Running full update..."
/opt/pincerna/deploy/update_site.sh

echo ""
echo "========================================="
echo "Fresh start complete!"
echo "========================================="
echo ""
echo "Service status:"
systemctl status pincerna --no-pager