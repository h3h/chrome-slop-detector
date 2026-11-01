function makeArea() {
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
      for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
    async clear() {
      data = {};
    }
  };
}

export function createChromeStub() {
  const storageListeners = [];
  const listeners = { message: [], installed: [], tabRemoved: [] };
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
    _fireTabRemoved(id) {
      for (const l of listeners.tabRemoved) l(id);
    },
    _fireStorageChange(changes, area = 'local') {
      for (const l of storageListeners) l(changes, area);
    },
    storage: {
      local: makeArea(),
      session: makeArea(),
      onChanged: { addListener: (fn) => storageListeners.push(fn) }
    },
    runtime: {
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      async sendMessage(msg) {
        chrome._sent.push(msg);
      }
    },
    tabs: {
      async query() {
        return [];
      },
      async sendMessage(tabId, msg) {
        chrome._tabMessages.push({ tabId, msg });
      },
      onRemoved: { addListener: (fn) => listeners.tabRemoved.push(fn) }
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
