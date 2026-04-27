'use strict';

// ── DOM selectors ─────────────────────────────────────────────────────────────
// FIELD VERIFY: Open DevTools on the live Foundry AI FDE page and confirm
// each selector before relying on this. These are best-guess patterns based
// on common React SPA conventions.
//
// Recommended DevTools snippet to find selectors:
//   document.querySelectorAll('[data-testid]')  — lists all testid elements
//   document.querySelectorAll('[contenteditable]')  — finds editable areas
//   document.querySelectorAll('button[disabled]')  — check send button
//
const SELECTORS = {
  // Chat input: try Slate.js contenteditable, then generic contenteditable, then textarea
  chatInput:        [
    '[data-testid="chat-input"]',
    '[contenteditable="true"][data-slate-editor]',
    '[contenteditable="true"][role="textbox"]',
    'textarea[data-testid]',
    'textarea[placeholder*="message" i]',
    'textarea[placeholder*="prompt" i]',
  ].join(', '),

  // Submit / send button
  sendButton:       [
    '[data-testid="send-button"]',
    'button[aria-label="Send"]',
    'button[aria-label="Submit"]',
    'button[type="submit"]',
  ].join(', '),

  // AI response message containers — pick the last one after response completes
  aiMessages:       [
    '[data-author="assistant"]',
    '[data-testid="ai-message"]',
    '[data-role="assistant"]',
    '.ai-message',
    '[role="article"][data-message-author-role="assistant"]',
  ].join(', '),

  // New session / new conversation control
  newSessionButton: [
    '[data-testid="new-conversation"]',
    '[data-testid="new-session"]',
    'button[aria-label="New session"]',
    'button[aria-label="New conversation"]',
  ].join(', '),

  // Settings panel toggle (to access tool toggles)
  settingsButton:   [
    '[data-testid="settings-panel-toggle"]',
    'button[aria-label="Settings"]',
    'button[aria-label="Configure tools"]',
  ].join(', '),
};

// Tool toggle selectors — FIELD VERIFY against the actual Foundry FDE settings panel
// Open the tools panel and inspect each toggle's data-testid or aria-label
const TOGGLE_MAP = {
  transforms:      '[data-testid="toggle-transforms"], [aria-label="Transforms"]',
  ontologyEditing: '[data-testid="toggle-ontology-editing"], [aria-label="Ontology editing"]',
  codeRepo:        '[data-testid="toggle-code-repo"], [aria-label="Code repository"]',
  functions:       '[data-testid="toggle-functions"], [aria-label="Functions"]',
  pipelineBuilder: '[data-testid="toggle-pipeline-builder"], [aria-label="Pipeline Builder"]',
  osdk:            '[data-testid="toggle-osdk"], [aria-label="OSDK"]',
};

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForElement(selector, timeoutMs = 10_000) {
  const el = document.querySelector(selector);
  if (el) return Promise.resolve(el);

  return new Promise((resolve) => {
    const obs = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) { obs.disconnect(); resolve(found); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); resolve(null); }, timeoutMs);
  });
}

// ── React text injection ──────────────────────────────────────────────────────

function injectText(element, text) {
  element.focus();

  const isTextarea = element.tagName.toLowerCase() === 'textarea';

  if (isTextarea) {
    // For <textarea>: use the native prototype setter to bypass React's instance override
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype, 'value'
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(element, text);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    element.value = text;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  // For contenteditable: execCommand is the most reliable path for React 18
  // It sets nativeEvent.data correctly, which React's synthetic event system requires.
  document.execCommand('selectAll');
  const inserted = document.execCommand('insertText', false, text);
  if (inserted) return true;

  // Fallback 1: direct textContent + InputEvent
  element.textContent = text;
  const evt = new InputEvent('input', {
    bubbles:   true,
    cancelable: true,
    inputType: 'insertText',
    data:      text,
  });
  element.dispatchEvent(evt);

  // Fallback 2: React fiber walk — find nearest onChange and call it directly
  const fiberKey = Object.keys(element).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
  if (fiberKey) {
    let node = element[fiberKey];
    while (node) {
      const handler = node.memoizedProps?.onChange ?? node.pendingProps?.onChange;
      if (typeof handler === 'function') {
        handler({ target: element, nativeEvent: evt, currentTarget: element });
        return true;
      }
      node = node.return;
    }
  }

  return false;
}

// ── Response completion detection ─────────────────────────────────────────────

function waitForResponseCompletion(timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    let stabilityTimer = null;

    const hardTimer = setTimeout(() => {
      cleanup();
      reject({ code: 408, message: 'Timeout waiting for FDE response', partial: extractResponse() });
    }, timeoutMs);

    function cleanup() {
      observer.disconnect();
      clearTimeout(stabilityTimer);
      clearTimeout(hardTimer);
    }

    function finish() {
      cleanup();
      resolve(extractResponse());
    }

    function scheduleStabilityCheck() {
      clearTimeout(stabilityTimer);
      stabilityTimer = setTimeout(finish, 2000);
    }

    const sendBtn = document.querySelector(SELECTORS.sendButton);

    function isSendButtonEnabled(btn) {
      if (!btn) return false;
      return !btn.disabled
        && btn.getAttribute('aria-disabled') !== 'true'
        && !btn.classList.contains('disabled');
    }

    const observer = new MutationObserver(() => {
      clearTimeout(stabilityTimer);

      // Primary signal: send button re-enabled
      if (isSendButtonEnabled(sendBtn)) {
        // Small delay to let React flush the final text render
        setTimeout(finish, 150);
        return;
      }

      scheduleStabilityCheck();
    });

    observer.observe(document.body, {
      childList:       true,
      subtree:         true,
      characterData:   true,
      attributes:      true,
      attributeFilter: ['disabled', 'aria-disabled', 'class'],
    });

    // Kick off the initial stability check (handles the case where the button
    // was never disabled, e.g., on a very fast response)
    scheduleStabilityCheck();
  });
}

function extractResponse() {
  const containers = document.querySelectorAll(SELECTORS.aiMessages);
  if (!containers.length) return '';
  const last = containers[containers.length - 1];
  return (last.innerText ?? last.textContent ?? '').trim();
}

// ── Config reconciliation ─────────────────────────────────────────────────────

async function applyFdeConfig(config) {
  if (!config) return;

  // Open settings panel if needed
  const settingsBtn = document.querySelector(SELECTORS.settingsButton);
  if (settingsBtn) {
    settingsBtn.click();
    await sleep(400); // Wait for panel to open
  }

  for (const [toolName, selector] of Object.entries(TOGGLE_MAP)) {
    const desired = config.tools?.[toolName];
    if (desired === undefined) continue;

    const toggle = document.querySelector(selector);
    if (!toggle) {
      console.warn(`[fde-bridge] Toggle not found for tool "${toolName}" — skipping. FIELD VERIFY selector: ${selector}`);
      continue;
    }

    const isChecked = toggle.getAttribute('aria-checked') === 'true'
      || toggle.checked === true
      || toggle.classList.contains('active')
      || toggle.classList.contains('enabled');

    if (Boolean(desired) !== Boolean(isChecked)) {
      toggle.click();
      await sleep(100); // Let React batch-render before checking the next toggle
    }
  }

  // Approval mode — FIELD VERIFY: how approvalMode maps to actual UI controls
  if (config.approvalMode) {
    const approvalSelector = `[data-testid="approval-mode-${config.approvalMode}"], [aria-label="${config.approvalMode}"]`;
    const approvalControl = document.querySelector(approvalSelector);
    if (approvalControl) {
      approvalControl.click();
      await sleep(100);
    } else {
      console.warn(`[fde-bridge] Approval mode control not found for "${config.approvalMode}" — FIELD VERIFY selector`);
    }
  }

  // Close settings panel if we opened it
  if (settingsBtn) {
    settingsBtn.click();
    await sleep(200);
  }
}

// ── Session management ────────────────────────────────────────────────────────

async function startNewSession() {
  const btn = document.querySelector(SELECTORS.newSessionButton);
  if (btn) {
    btn.click();
    await sleep(600);
    return;
  }

  // Fallback: navigate to the FDE base URL
  // FIELD VERIFY: actual FDE route on your Foundry instance
  const fdeUrl = `${window.location.origin}/workspace/data-integration/fde`;
  window.location.href = fdeUrl;
  await waitForElement(SELECTORS.chatInput, 15_000);
}

// ── Main execution flow ───────────────────────────────────────────────────────

async function executePrompt(payload) {
  const { prompt, new_session, config_override, timeout_ms } = payload;

  if (new_session) {
    await startNewSession();
  }

  // Apply config (from override or extension storage)
  let config = config_override;
  if (!config) {
    const stored = await chrome.storage.local.get('fdeConfig');
    config = stored.fdeConfig ?? null;
  }
  if (config) {
    await applyFdeConfig(config);
  }

  // Find input
  const input = await waitForElement(SELECTORS.chatInput, 10_000);
  if (!input) {
    throw new Error(`Chat input not found. FIELD VERIFY selector: ${SELECTORS.chatInput}`);
  }

  // Inject prompt text
  injectText(input, prompt);

  // Brief pause for React to process the input before we click Send
  await sleep(250);

  // Submit
  const sendBtn = document.querySelector(SELECTORS.sendButton);
  if (!sendBtn) {
    throw new Error(`Send button not found. FIELD VERIFY selector: ${SELECTORS.sendButton}`);
  }
  sendBtn.click();

  // Wait for response to complete
  const responseText = await waitForResponseCompletion(timeout_ms ?? 300_000);
  return { response: responseText };
}

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'fde_execute') return false;

  executePrompt(msg.payload)
    .then(result => sendResponse({ ok: true, result }))
    .catch(err   => sendResponse({ ok: false, error: err?.message ?? String(err) }));

  return true; // Keep channel open for async sendResponse
});

// Announce readiness to background
chrome.runtime.sendMessage({ type: 'fde_ready' }).catch(() => {});
