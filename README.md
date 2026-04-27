# FDE Bridge

Enables Claude Code to programmatically drive [Palantir AI FDE](https://www.palantir.com/platforms/foundry/) sessions via a Chrome extension. Claude Code sends a prompt, FDE processes it, and the response flows back as a native MCP tool call — no manual browser interaction required.

## How It Works

```
Claude Code → fde_run() → HTTP :27182 → native-host → native messaging → Chrome extension → Foundry DOM
```

A small Node.js process (`native-host/server.js`) owns the HTTP server on `127.0.0.1:27182`. The Chrome extension connects to it via Chrome's native messaging protocol (stdin/stdout). When Claude calls `fde_run`, the request flows through this chain, the content script injects the prompt into the FDE chat input, waits for the full response, and returns the text.

## Prerequisites

- Chrome with Developer Mode enabled
- Node.js 18+
- A Palantir Foundry stack on `*.palantirfoundry.com` with AI FDE enabled and an authenticated browser session open

## Setup

### 1. Install the native messaging host

```bash
cd native-host
chmod +x install.sh
./install.sh
```

This generates `~/.config/fde-bridge/token` and registers the native messaging manifest with Chrome. The extension ID is pre-baked — no manual ID update needed.

### 2. Load the Chrome extension

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `extension/` folder from this repo
4. Confirm the extension ID shown is `mmoolbcfmhiijogpplbcepihjpacmfaj`

### 3. Build the MCP tool

```bash
cd mcp-tool
npm install
npm run build
```

### 4. Configure Claude Code

Set the auth token in your environment (add to `~/.zshrc` or `~/.bashrc`):

```bash
export FDE_BRIDGE_TOKEN=$(cat ~/.config/fde-bridge/token)
```

The `.mcp.json` in this repo root registers the `fde_run` tool automatically when Claude Code is started from this directory.

### 5. Open a Foundry tab

Navigate to your AI FDE page in Chrome. The extension popup (click the puzzle-piece icon) should show green status for both "Native host" and "FDE tab".

### 6. Verify the pipe

```bash
curl -s -X GET http://127.0.0.1:27182/health \
  -H "X-FDE-Token: $(cat ~/.config/fde-bridge/token)" | jq
# → { "ok": true, "extensionConnected": true }

curl -s -X POST http://127.0.0.1:27182/fde \
  -H "X-FDE-Token: $(cat ~/.config/fde-bridge/token)" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "What tools do you have available?"}' | jq
```

## Usage in Claude Code

Once configured, Claude Code has access to the `fde_run` tool:

```
# Continue current session
fde_run("Create a transform that joins datasets A and B on the ID column")

# Start a fresh session
fde_run("Scaffold an OSDK React app for the Flight Alerts ontology", new_session=true)

# With per-call config override
fde_run(
  "Edit the Employee ontology to add a 'department' property",
  config_override={
    "tools": { "ontologyEditing": true, "codeRepo": false },
    "approvalMode": "auto-approve-branch"
  }
)
```

## Configuration

Create `~/.config/fde-bridge/fde-config.json` to set default tool toggles and approval mode for every session:

```json
{
  "tools": {
    "transforms": true,
    "ontologyEditing": true,
    "codeRepo": true,
    "functions": false,
    "pipelineBuilder": false,
    "osdk": true
  },
  "approvalMode": "auto-approve-branch",
  "launchMode": "code",
  "branchName": "feature/claude-automation"
}
```

See `config/fde-config.schema.json` for the full schema. An example is at `config/fde-config.example.json`.

## DOM Selector Verification

> **Required before first use**: The content script uses best-guess selectors for the FDE chat input, send button, and tool toggles. These must be verified against your live Foundry instance before automation will work reliably.

Open DevTools on your Foundry AI FDE page and run:

```javascript
// Find all elements with data-testid
document.querySelectorAll('[data-testid]').forEach(el =>
  console.log(el.tagName, el.getAttribute('data-testid'), el.getAttribute('aria-label'))
);

// Find the chat input
document.querySelectorAll('[contenteditable], textarea');

// Find the send button
document.querySelectorAll('button[disabled], button[aria-disabled]');
```

Update `SELECTORS` and `TOGGLE_MAP` in `extension/content-script.js` with the actual values you find.

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `503 Extension not connected` | No Foundry tab open | Open a Foundry AI FDE page in Chrome, wait ~5s |
| `404 No FDE tab found` | Foundry tab not detected | Check URL matches `*.palantirfoundry.com` |
| `401 Unauthorized` | Wrong token | Run `echo $FDE_BRIDGE_TOKEN` vs `cat ~/.config/fde-bridge/token` |
| Native host not found | Manifest not registered | Re-run `install.sh` |
| Prompt injected but no response | Wrong send button selector | Verify in DevTools; update `SELECTORS.sendButton` |
| Response timeout | Streaming never completed | Check `SELECTORS.sendButton` disabled mechanism |

**Logs:** `tail -f ~/.config/fde-bridge/server.log`

## Project Structure

```
.
├── extension/            Chrome MV3 extension
│   ├── manifest.json     Permissions, stable extension key
│   ├── background.js     Service worker: native messaging + alarm keepalive
│   ├── content-script.js DOM interaction (FIELD VERIFY selectors here)
│   ├── popup.html/.js    Status display
├── native-host/          Node.js HTTP + native messaging bridge
│   ├── server.js         HTTP server on 127.0.0.1:27182
│   ├── install.sh        One-time setup script
│   └── com.palantir.fde.bridge.json  NMH manifest template
├── mcp-tool/             Claude Code MCP tool
│   └── index.ts          Exposes fde_run() via StdioServerTransport
├── config/
│   ├── fde-config.schema.json
│   └── fde-config.example.json
└── .mcp.json             MCP server registration for Claude Code
```
