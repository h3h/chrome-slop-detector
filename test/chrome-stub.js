function makeArea(onChange = () => {}) {
  let data = {};
  return {
    async get(keys) {
      if (keys == null) return structuredClone(data);
      if (typeof keys === 'string') keys = [keys];
      const out = {};
      if (Array.isArray(keys)) {
        for (const k of keys) if (k in data) out[k] = structuredClone(data[k]);
      } else {
        for (const [k, def] of Object.entries(keys)) out[k] = k in data ? structuredClone(data[k]) : structuredClone(def);
      }
      return out;
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: k in data ? structuredClone(data[k]) : undefined, newValue: structuredClone(v) };
        data[k] = structuredClone(v);
      }
      onChange(changes);
    },
    async remove(keys) {
      const changes = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (k in data) changes[k] = { oldValue: structuredClone(data[k]), newValue: undefined };
        delete data[k];
      }
      if (Object.keys(changes).length) onChange(changes);
    },
    async clear() {
      data = {};
    }
  };
}

export function createChromeStub() {
  const storageListeners = [];
  const listeners = { message: [], installed: [], tabRemoved: [], tabUpdated: [] };
  // Real chrome.storage.onChanged fires asynchronously after the write resolves.
  const fireStorage = (area) => (changes) => {
    const copy = structuredClone(changes);
    queueMicrotask(() => { for (const l of storageListeners) l(copy, area); });
  };
  const chrome = {
    _sent: [],
    _tabMessages: [],
    // Map<tabId, {text, color}>
    _badges: new Map(),
    _listeners: listeners,
    _fireMessage(msg, sender = {}) {
      return new Promise((resolve) => {
        let async = false;
        for (const l of listeners.message) if (l(msg, sender, resolve) === true) async = true;
        if (!async) resolve(undefined);
      });
    },
    _fireTabUpdated(id, changeInfo = {}, tab = { id }) {
      for (const l of listeners.tabUpdated) l(id, changeInfo, tab);
    },
    _fireTabRemoved(id) {
      for (const l of listeners.tabRemoved) l(id);
    },
    _fireStorageChange(changes, area = 'local') {
      for (const l of storageListeners) l(changes, area);
    },
    storage: {
      local: makeArea(fireStorage('local')),
      session: makeArea(fireStorage('session')),
      onChanged: { addListener: (fn) => storageListeners.push(fn) }
    },
    runtime: {
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      id: 'stubextensionid',
      getURL: (path = '') => `chrome-extension://stubextensionid/${String(path).replace(/^\//, '')}`,
      async sendMessage(msg) {
        chrome._sent.push(msg);
      }
    },
    tabs: {
      async query() {
        return [];
      },
      async sendMessage(tabId, msg, options) {
        chrome._tabMessages.push(options === undefined ? { tabId, msg } : { tabId, msg, options });
      },
      onRemoved: { addListener: (fn) => listeners.tabRemoved.push(fn) },
      onUpdated: { addListener: (fn) => listeners.tabUpdated.push(fn) }
    },
    action: {
      async setBadgeText({ text, tabId }) {
        const b = chrome._badges.get(tabId) || {};
        chrome._badges.set(tabId, { ...b, text });
      },
      async setBadgeBackgroundColor({ color, tabId }) {
        const b = chrome._badges.get(tabId) || {};
        chrome._badges.set(tabId, { ...b, color });
      },
      async getBadgeText({ tabId }) {
        return (chrome._badges.get(tabId) || {}).text ?? '';
      }
    }
  };
  return chrome;
}
