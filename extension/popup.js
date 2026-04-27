async function refresh() {
  const data = await chrome.storage.local.get([
    'nativeConnected',
    'activeFdeTabId',
    'fdeConfig',
    'lastActivity',
  ]);

  const nativeDot    = document.getElementById('native-dot');
  const nativeStatus = document.getElementById('native-status');
  const tabDot       = document.getElementById('tab-dot');
  const tabStatus    = document.getElementById('tab-status');
  const configStatus = document.getElementById('config-status');
  const lastActivity = document.getElementById('last-activity');

  if (data.nativeConnected) {
    nativeDot.className   = 'dot green';
    nativeStatus.textContent = 'Connected';
  } else {
    nativeDot.className   = 'dot red';
    nativeStatus.textContent = 'Disconnected';
  }

  if (data.activeFdeTabId) {
    tabDot.className   = 'dot green';
    tabStatus.textContent = `Tab ${data.activeFdeTabId}`;
  } else {
    tabDot.className   = 'dot yellow';
    tabStatus.textContent = 'No FDE tab';
  }

  if (data.fdeConfig) {
    const mode = data.fdeConfig.launchMode ?? 'default';
    const toolCount = Object.values(data.fdeConfig.tools ?? {}).filter(Boolean).length;
    configStatus.textContent = `${mode} · ${toolCount} tools`;
  } else {
    configStatus.textContent = 'none';
  }

  if (data.lastActivity) {
    const d = new Date(data.lastActivity);
    lastActivity.textContent = `Last: ${d.toLocaleTimeString()}`;
  }
}

refresh();
setInterval(refresh, 2000);
