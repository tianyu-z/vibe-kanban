#!/bin/bash

set -e  # Exit on any error

# Detect OS and architecture
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

# Map architecture names
case "$ARCH" in
  x86_64)
    ARCH="x64"
    ;;
  arm64|aarch64)
    ARCH="arm64"
    ;;
  *)
    echo "⚠️  Warning: Unknown architecture $ARCH, using as-is"
    ;;
esac

# Map OS names
case "$OS" in
  linux)
    OS="linux"
    ;;
  darwin)
    OS="macos"
    ;;
  *)
    echo "⚠️  Warning: Unknown OS $OS, using as-is"
    ;;
esac

PLATFORM="${OS}-${ARCH}"

# Set CARGO_TARGET_DIR if not defined
if [ -z "$CARGO_TARGET_DIR" ]; then
  CARGO_TARGET_DIR="target"
fi

echo "🔍 Detected platform: $PLATFORM"
echo "🔧 Using target directory: $CARGO_TARGET_DIR"

# Set API base URL for remote features
export VK_SHARED_API_BASE="https://api.vibekanban.com"
export VITE_VK_SHARED_API_BASE="https://api.vibekanban.com"

echo "🧹 Cleaning previous builds..."
rm -rf npx-cli/dist
mkdir -p npx-cli/dist/$PLATFORM

echo "🔨 Building web app..."
(cd packages/local-web && npm run build)

echo "🔨 Building Rust binaries..."
# Build only the binaries the CLI dist ships (server, review, vibe-kanban-mcp).
# A bare `cargo build --release` builds the whole workspace including the
# `tauri-app` crate, which on Linux pulls gobject-sys/GTK via pkg-config —
# unavailable on headless HPC login nodes without sudo. The desktop app is built
# separately under --desktop/--all, so the CLI build never needs it.
cargo build --release --manifest-path Cargo.toml \
  --bin server --bin review --bin vibe-kanban-mcp

echo "📦 Creating distribution package..."

# Portable single-file zip: use the `zip` binary when present, else fall back to
# python3 (always available on HPC login nodes; `zip` often is not). The npx CLI
# extracts with adm-zip and chmod 0755s the binary afterwards, so the archived
# unix mode does not matter.
zip_one() { # zip_one <archive.zip> <file>
  if command -v zip >/dev/null 2>&1; then
    zip -q "$1" "$2"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$1" "$2" <<'PY'
import os, sys, zipfile
archive, path = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
    z.write(path, os.path.basename(path))
PY
  else
    echo "Error: need either 'zip' or 'python3' to package binaries" >&2
    exit 1
  fi
}

# Copy the main binary
cp ${CARGO_TARGET_DIR}/release/server vibe-kanban
zip_one vibe-kanban.zip vibe-kanban
rm -f vibe-kanban
mv vibe-kanban.zip npx-cli/dist/$PLATFORM/vibe-kanban.zip

# Copy the MCP binary
cp ${CARGO_TARGET_DIR}/release/vibe-kanban-mcp vibe-kanban-mcp
zip_one vibe-kanban-mcp.zip vibe-kanban-mcp
rm -f vibe-kanban-mcp
mv vibe-kanban-mcp.zip npx-cli/dist/$PLATFORM/vibe-kanban-mcp.zip

# Copy the Review CLI binary
cp ${CARGO_TARGET_DIR}/release/review vibe-kanban-review
zip_one vibe-kanban-review.zip vibe-kanban-review
rm -f vibe-kanban-review
mv vibe-kanban-review.zip npx-cli/dist/$PLATFORM/vibe-kanban-review.zip

echo "✅ CLI build complete!"
echo "📁 Files created:"
echo "   - npx-cli/dist/$PLATFORM/vibe-kanban.zip"
echo "   - npx-cli/dist/$PLATFORM/vibe-kanban-mcp.zip"
echo "   - npx-cli/dist/$PLATFORM/vibe-kanban-review.zip"

# Optionally build the Tauri desktop app
if [[ "$1" == "--desktop" || "$1" == "--all" ]]; then
  # Map to Tauri platform naming
  case "$OS" in
    macos) TAURI_OS="darwin" ;;
    linux) TAURI_OS="linux" ;;
    *) TAURI_OS="$OS" ;;
  esac
  case "$ARCH" in
    arm64) TAURI_ARCH="aarch64" ;;
    x64) TAURI_ARCH="x86_64" ;;
    *) TAURI_ARCH="$ARCH" ;;
  esac
  TAURI_PLATFORM="${TAURI_OS}-${TAURI_ARCH}"

  echo ""
  echo "🖥️  Building Tauri desktop app for $TAURI_PLATFORM..."

  # Replace the updater endpoint placeholder with a dummy URL for local builds
  # (CI injects the real R2 URL; locally the updater is non-functional)
  TAURI_CONF="crates/tauri-app/tauri.conf.json"
  node -e "
    const fs = require('fs');
    const conf = JSON.parse(fs.readFileSync('$TAURI_CONF', 'utf8'));
    conf.plugins.updater.endpoints = conf.plugins.updater.endpoints.map(e =>
      e === '__TAURI_UPDATE_ENDPOINT__' ? 'https://localhost/disabled' : e
    );
    fs.writeFileSync('$TAURI_CONF', JSON.stringify(conf, null, 2) + '\n');
  "

  cargo tauri build

  # Restore tauri.conf.json
  git checkout -- "$TAURI_CONF"

  TAURI_DIST="npx-cli/dist/tauri/$TAURI_PLATFORM"
  mkdir -p "$TAURI_DIST"

  BUNDLE_DIR="${CARGO_TARGET_DIR}/release/bundle"
  # Copy updater artifacts (tar.gz bundles or NSIS exe)
  find "$BUNDLE_DIR" -name "*.app.tar.gz" ! -name "*.sig" -exec cp {} "$TAURI_DIST/" \; 2>/dev/null || true
  find "$BUNDLE_DIR" -name "*.AppImage.tar.gz" ! -name "*.sig" -exec cp {} "$TAURI_DIST/" \; 2>/dev/null || true
  find "$BUNDLE_DIR" -name "*-setup.exe" -exec cp {} "$TAURI_DIST/" \; 2>/dev/null || true

  echo "✅ Desktop app built:"
  ls -la "$TAURI_DIST/"
fi

echo ""
echo "📦 Installing npx-cli dependencies..."
(cd npx-cli && npm ci)

echo ""
echo "🔨 Building npx-cli TypeScript..."
(cd npx-cli && npm run build)

echo ""
echo "🚀 To test locally, run:"
echo "   cd npx-cli && node bin/cli.js                # browser mode (default)"
echo "   cd npx-cli && node bin/cli.js --desktop       # desktop mode (requires --desktop or --all build flag)"
