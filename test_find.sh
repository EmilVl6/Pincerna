#!/bin/bash
# Test script to verify $RECYCLE.BIN filtering works

FILES_ROOT="/mnt"
VID_EXTS='-iname *.mp4 -o -iname *.mkv -o -iname *.mov -o -iname *.avi -o -iname *.webm -o -iname *.m4v -o -iname *.mpg -o -iname *.mpeg -o -iname *.ts -o -iname *.flv'

echo "Testing find command with exclusions..."
echo ""

mapfile -t videos < <(find "$FILES_ROOT" -type f \( $VID_EXTS \) ! -path '*/$RECYCLE.BIN/*' ! -path '*/System Volume Information/*' ! -path '*/.Trash-*/*' ! -path '*/lost+found/*' -print 2>/dev/null || true)

echo "Found ${#videos[@]} videos:"
echo ""

for v in "${videos[@]}"; do
    size=$(stat -c%s "$v" 2>/dev/null || echo 0)
    size_mb=$((size / 1048576))
    echo "$v ($size_mb MB)"
done

echo ""
echo "Testing if any $RECYCLE.BIN files leaked through:"
for v in "${videos[@]}"; do
    if [[ "$v" == *'$RECYCLE.BIN'* ]]; then
        echo "ERROR: Found recycle bin file: $v"
    fi
done

echo ""
echo "Done!"
