#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_DIR="$REPO_ROOT/services/api"
BINARY_OUT="$API_DIR/pincerna_api"

log() { echo -e "\033[38;2;255;122;0m[build_backend]\033[0m $1"; }

log "Building Rust backend (pincerna_api)"

# Install rustup if not present
if ! command -v cargo &>/dev/null; then
    log "Installing Rust toolchain via rustup..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
    . "$HOME/.cargo/env"
fi

cd "$API_DIR"

# Build in release mode
log "Running cargo build --release..."
cargo build --release

# Copy binary to expected location
cp "$API_DIR/target/release/pincerna_api" "$BINARY_OUT"
chmod 750 "$BINARY_OUT"
log "Build complete: $BINARY_OUT"
