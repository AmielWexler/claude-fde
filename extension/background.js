// Service worker — MV3
// Owns the native messaging port lifetime and routes messages between
// the native host and content scripts.

const NATIVE_HOST   = 'com.palantir.fde.bridge';
const ALARM_NAME    = 'fde-keepalive';
const ALARM_PERIOD  = 0.4; // minutes (24 seconds — under the 30s SW idle threshold)
const FOUNDRY_MATCH = 'https://*.palantirfoundry.com/*';

let nativePort      = null;
let activeFdeTabId  = null;

// ── Port management ───────────────────────────────────────────────────────────

function ensureNativePort() {
  if (nativePort) return nativePort;

  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    console.error('[bg] connectNative failed:', e);
    updateStorage({ nativeConnected: false });
    return null;
  }

  nativePort.onMessage.addListener(onNativeMessage);

  nativePort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message ?? 'unknown';
    console.warn('[bg] native port disconnected:', err);
    nativePort = null;
    updateStorage({ nativeConnected: false });
  });

  updateStorage({ nativeConnected: true });
  return nativePort;
}

function sendToNative(msg) {
  const port = ensureNativePort();
  if (!port) return;
  try {
    port.postMessage(msg);
  } catch (e) {
    console.error('[bg] postMessage failed:', e);
    nativePort = null;
    updateStorage({ nativeConnected: false });
  }
}

function updateStorage(data) {
  chrome.storage.local.set(data).catch(() => {});
}

// ── Alarm keepalive ───────────────────────────────────────────────────────────
// Alarms keep the SW event loop alive beyond the 30s idle window.
// We also use each tick to ping the native host and reconnect if the port dropped.

chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  if (nativePort) {
    sendToNative({ type: 'ping' });
  } else {
    ensureNativePort();
  }
});

// ── Native → SW message routing ───────────────────────────────────────────────

async function onNativeMessage(msg) {
  // Re-check port on every handler entry (defensive against crbug.com/1375254)
  ensureNativePort();

  switch (msg.type) {
    case 'pong':
      break;

    case 'handshake':
      if (msg.token) {
        await chrome.storage.local.set({ fdeAuthToken: msg.token });
      }
      updateStorage({ nativeConnected: true });
      break;

    case 'config_sync':
      if (msg.config) {
        await chrome.storage.local.set({ fdeConfig: msg.config });
      }
      break;

    case 'request':
      await handleFdeRequest(msg.requestId, msg.payload);
      break;

    default:
      console.warn('[bg] Unknown message type from native host:', msg.type);
  }
}

// ── FDE request lifecycle ─────────────────────────────────────────────────────

async function handleFdeRequest(requestId, payload) {
  const tabId = await resolveOrOpenFdeTab(payload.new_session);

  if (!tabId) {
    sendToNative({
      type: 'response',
      requestId,
      error: { code: 404, message: 'No Foundry tab found. Open a Foundry AI FDE page in Chrome.' },
    });
    return;
  }

  activeFdeTabId = tabId;
  updateStorage({ activeFdeTabId: tabId });

  try {
    // Inject content script if needed (handles tab discarding / fresh navigation)
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-script.js'],
    }).catch(() => {}); // Already injected = benign error
  } catch (_) { /* ignore */ }

  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, {
      type: 'fde_execute',
      requestId,
      payload,
    });
  } catch (e) {
    // Tab may have been discarded; try reloading once
    try {
      await chrome.tabs.reload(tabId);
      await waitForContentScript(tabId, 10_000);
      response = await chrome.tabs.sendMessage(tabId, {
        type: 'fde_execute',
        requestId,
        payload,
      });
    } catch (e2) {
      sendToNative({
        type: 'response',
        requestId,
        error: { code: 500, message: `Content script unreachable: ${String(e2)}` },
      });
      return;
    }
  }

  if (response?.ok) {
    sendToNative({ type: 'response', requestId, result: response.result });
  } else {
    sendToNative({
      type: 'response',
      requestId,
      error: { code: 500, message: response?.error ?? 'Content script returned no response' },
    });
  }
}

async function resolveOrOpenFdeTab(newSession) {
  const tabs = await chrome.tabs.query({ url: FOUNDRY_MATCH });

  // Continue existing session: prefer previously tracked tab, then any open Foundry tab
  if (!newSession) {
    if (activeFdeTabId) {
      const known = tabs.find(t => t.id === activeFdeTabId);
      if (known) return known.id;
    }
    if (tabs.length > 0) return tabs[0].id;
    return null;
  }

  // New session: navigate existing tab to FDE URL
  if (tabs.length > 0) {
    const tab = tabs[0];
    const fdeUrl = deriveFdeUrl(tab.url);
    await chrome.tabs.update(tab.id, { url: fdeUrl });
    return tab.id;
  }

  return null;
}

function deriveFdeUrl(existingUrl) {
  try {
    const u = new URL(existingUrl);
    // FIELD VERIFY: actual FDE route path on your Foundry instance
    return `${u.origin}/workspace/data-integration/fde`;
  } catch {
    return existingUrl;
  }
}

// Wait until the content script in a tab sends 'fde_ready'
function waitForContentScript(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Content script timeout')), timeoutMs);

    const listener = (msg, sender) => {
      if (msg.type === 'fde_ready' && sender.tab?.id === tabId) {
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        resolve();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
  });
}

// ── Messages from content script ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'fde_ready') {
    const tabId = sender.tab?.id;
    if (tabId) {
      activeFdeTabId = tabId;
      updateStorage({ activeFdeTabId: tabId, nativeConnected: true });
      sendToNative({ type: 'tab_status', tabId, status: 'ready' });
    }
  }
  // No async response needed here
  return false;
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => ensureNativePort());
chrome.runtime.onStartup.addListener(() => ensureNativePort());
