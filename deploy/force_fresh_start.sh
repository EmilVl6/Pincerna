#!/bin/bash

systemctl stop pincerna
rm -f /mnt/.video_index.json
rm -f /mnt/.video_index.ts
rm -rf /mnt/.thumbs/*
rm -rf /mnt/.previews/*
find /opt/pincerna -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
find /opt/pincerna -type f -name "*.pyc" -delete 2>/dev/null || true
cd /opt/pincerna
git fetch origin
git reset --hard origin/main
/opt/pincerna/deploy/update_site.sh

echo "Fresh Start Complete"
echo "Service status:"
systemctl status pincerna --no-pager