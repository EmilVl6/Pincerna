#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_DIR="$REPO_ROOT/services/api"
BINARY_OUT="$API_DIR/pincerna_api"

log() { echo -e "\033[38;2;255;122;0m[build_backend]\033[0m $1"; }

log "Building C++ backend (pincerna_api)"

# Clean previous build
if [ -d "$API_DIR/build" ]; then
    rm -rf "$API_DIR/build"
fi
mkdir -p "$API_DIR/build"
cd "$API_DIR/build"

# Prefer CMake if CMakeLists.txt exists, else fallback to g++
if [ -f "$API_DIR/CMakeLists.txt" ]; then
    log "Detected CMakeLists.txt, using cmake..."
    cmake ..
    make -j$(nproc)
    cp pincerna_api "$BINARY_OUT"
elif ls ../*.cpp >/dev/null 2>&1; then
    log "No CMakeLists.txt, compiling all .cpp files with g++..."
    g++ -O2 -std=c++17 ../*.cpp -o "$BINARY_OUT" -lpistache -lssl -lcrypto -ljsoncpp -pthread
else
    log "No C++ source files found in $API_DIR"
    exit 1
fi

chmod 750 "$BINARY_OUT"
log "Build complete: $BINARY_OUT"
