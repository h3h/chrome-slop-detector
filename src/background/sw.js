// MV3 module service worker. Everything below runs synchronously at top level so the
// listeners exist before Chrome dispatches the event that woke the worker.
import {
  handleClassify, getTabState, clearTabState, clearTabStateIfUrlChanged, refreshBadges, denyHost, testProvider
} from './core.js';
import { loadSettings, saveSettings } from '../lib/settings.js';

const inflight = new Map();
const deps = { chrome, fetch: (...a) => fetch(...a), inflight };

const EXT_ONLY = new Set(['get-tab-state', 'check-tab', 'deny-host', 'test-provider', 'get-settings', 'save-settings']);

function requireTabId(tabId) {
  if (!Number.isInteger(tabId)) throw new Error('tabId must be an integer');
  return tabId;
}

async function route(msg, sender) {
  const type = msg?.type;
  // Extension pages (popup/options) vs. content scripts in web pages.
  const ext = typeof sender?.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
  const fromContent = !!sender?.tab && sender.frameId === 0 && !ext;
  if (type === 'classify') {
    if (!fromContent) return { error: 'forbidden' };
    return handleClassify(msg, requireTabId(sender.tab.id), deps);
  }
  if (type === 'get-content-config') {
    if (!fromContent) return { error: 'forbidden' };
    // Only what the content script needs; never the key or endpoint.
    const { mode, denyList } = await loadSettings(chrome.storage.local);
    return { mode, denyList: [...denyList] };
  }
  if (EXT_ONLY.has(type) && !ext) return { error: 'forbidden' };
  switch (type) {
    case 'get-tab-state':
      return getTabState(requireTabId(msg.tabId), deps);
    case 'check-tab':
    {
      const r = await chrome.tabs.sendMessage(requireTabId(msg.tabId), { type: 'run-check', force: !!msg.force }, { frameId: 0 });
      return { ok: true, skipped: typeof r?.skipped === 'string' ? r.skipped : null };
    }
    case 'deny-host':
      // Reply without settings: the full object carries the API key.
      await denyHost(msg.host, deps);
      return { ok: true };
    case 'test-provider':
      return testProvider(deps);
    case 'get-settings':
      return loadSettings(chrome.storage.local);
    case 'save-settings':
      try {
        return { ok: true, settings: await saveSettings(chrome.storage.local, msg.patch) };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  route(msg, sender).then(
    (res) => sendResponse(res),
    (e) => sendResponse({ error: String(e?.message || e) })
  );
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo?.url) clearTabStateIfUrlChanged(tabId, changeInfo.url, deps).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabState(tabId, deps).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  if (changes.settings.oldValue?.threshold === changes.settings.newValue?.threshold) return;
  refreshBadges(deps).catch(() => {});
});
