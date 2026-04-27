#!/usr/bin/env bash
# Installs the FDE Bridge native messaging host.
# Run once after loading the extension in Chrome.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$HOME/.config/fde-bridge"
TOKEN_FILE="$CONFIG_DIR/token"
NMH_NAME="com.palantir.fde.bridge"
# Stable extension ID — derived from the RSA key embedded in extension/manifest.json
EXTENSION_ID="mmoolbcfmhiijogpplbcepihjpacmfaj"

echo "=== FDE Bridge Native Host Installer ==="
echo ""

# ── Verify Node.js ────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js not found. Install Node.js 18+ and retry." >&2
  exit 1
fi

NODE_VERSION=$(node -e "process.stdout.write(process.versions.node)")
NODE_MAJOR="${NODE_VERSION%%.*}"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "ERROR: Node.js 18+ required (found $NODE_VERSION)." >&2
  exit 1
fi

NODE_PATH="$(command -v node)"
echo "Using Node.js $NODE_VERSION at $NODE_PATH"

# ── Config directory + auth token ─────────────────────────────────────────────
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

if [[ ! -f "$TOKEN_FILE" ]]; then
  TOKEN="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
  printf '%s' "$TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  echo "Generated new auth token at $TOKEN_FILE"
else
  TOKEN="$(cat "$TOKEN_FILE")"
  echo "Using existing auth token from $TOKEN_FILE"
fi

# ── Install npm dependencies ──────────────────────────────────────────────────
echo ""
echo "Installing native host dependencies..."
cd "$SCRIPT_DIR"
npm install --omit=dev --silent

# ── Write native messaging manifest ──────────────────────────────────────────
SERVER_PATH="$SCRIPT_DIR/server.js"

# Determine Chrome version for 'args' field compatibility
CHROME_VERSION=999
if command -v google-chrome &>/dev/null; then
  CHROME_VERSION="$(google-chrome --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || echo 999)"
elif command -v chromium &>/dev/null; then
  CHROME_VERSION="$(chromium --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || echo 999)"
elif [[ -d "/Applications/Google Chrome.app" ]]; then
  CHROME_VERSION="$(defaults read "/Applications/Google Chrome.app/Contents/Info" CFBundleShortVersionString 2>/dev/null | grep -oE '[0-9]+' | head -1 || echo 999)"
fi

if [[ "$CHROME_VERSION" -ge 114 ]]; then
  # Chrome 114+: 'args' field supported in NMH manifest
  cat > "$SCRIPT_DIR/$NMH_NAME.json" <<EOF
{
  "name": "$NMH_NAME",
  "description": "FDE Bridge native messaging host",
  "path": "$NODE_PATH",
  "args": ["$SERVER_PATH"],
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF
else
  # Older Chrome: generate a shell wrapper script as the host executable
  WRAPPER_PATH="$SCRIPT_DIR/server-wrapper.sh"
  cat > "$WRAPPER_PATH" <<WRAPPER
#!/usr/bin/env bash
exec "$NODE_PATH" "$SERVER_PATH" "\$@"
WRAPPER
  chmod +x "$WRAPPER_PATH"

  cat > "$SCRIPT_DIR/$NMH_NAME.json" <<EOF
{
  "name": "$NMH_NAME",
  "description": "FDE Bridge native messaging host",
  "path": "$WRAPPER_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF
  echo "Generated shell wrapper at $WRAPPER_PATH (Chrome $CHROME_VERSION doesn't support 'args' field)"
fi

# ── Register with Chrome ──────────────────────────────────────────────────────
OS="$(uname -s)"
if [[ "$OS" == "Darwin" ]]; then
  NMH_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  # Also register for Chrome Canary if present
  CANARY_DIR="$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
elif [[ "$OS" == "Linux" ]]; then
  NMH_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
  CHROMIUM_DIR="$HOME/.config/chromium/NativeMessagingHosts"
else
  echo "ERROR: Unsupported OS: $OS (only macOS and Linux are supported)" >&2
  exit 1
fi

mkdir -p "$NMH_DIR"
cp "$SCRIPT_DIR/$NMH_NAME.json" "$NMH_DIR/$NMH_NAME.json"
echo "Installed native messaging manifest to $NMH_DIR/$NMH_NAME.json"

if [[ "$OS" == "Darwin" ]] && [[ -d "$(dirname "$CANARY_DIR")" ]]; then
  mkdir -p "$CANARY_DIR"
  cp "$SCRIPT_DIR/$NMH_NAME.json" "$CANARY_DIR/$NMH_NAME.json"
  echo "Also installed to Chrome Canary: $CANARY_DIR/$NMH_NAME.json"
fi

if [[ "$OS" == "Linux" ]] && [[ -d "$(dirname "$CHROMIUM_DIR")" ]]; then
  mkdir -p "$CHROMIUM_DIR"
  cp "$SCRIPT_DIR/$NMH_NAME.json" "$CHROMIUM_DIR/$NMH_NAME.json"
  echo "Also installed to Chromium: $CHROMIUM_DIR/$NMH_NAME.json"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "=========================================="
echo "Installation complete!"
echo "=========================================="
echo ""
echo "Extension ID (stable):  $EXTENSION_ID"
echo "Auth token file:        $TOKEN_FILE"
echo ""
echo "Next steps:"
echo "  1. Open chrome://extensions in Chrome"
echo "  2. Enable Developer mode (top-right toggle)"
echo "  3. Click 'Load unpacked' and select: $(dirname "$SCRIPT_DIR")/extension"
echo "  4. Confirm the extension ID matches: $EXTENSION_ID"
echo ""
echo "Build and configure the MCP tool:"
echo "  cd $(dirname "$SCRIPT_DIR")/mcp-tool"
echo "  npm install && npm run build"
echo "  export FDE_BRIDGE_TOKEN=\$(cat $TOKEN_FILE)"
echo ""
echo "Test the HTTP endpoint (with a Foundry tab open):"
echo "  curl -s -X GET http://127.0.0.1:27182/health \\"
echo "    -H 'X-FDE-Token: \$(cat $TOKEN_FILE)' | jq"
echo ""
echo "Server logs: tail -f $CONFIG_DIR/server.log"
