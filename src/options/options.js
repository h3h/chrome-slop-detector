// Options page: edits settings through the service worker (save-settings validates).

const HOST_RE = /^[a-z0-9.-]+$/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//;

// One deny-list line -> bare hostname, or null if it isn't one. Accepts pasted URLs
// ("https://example.com/path" -> "example.com").
export function parseHost(line) {
  const x = line.trim().toLowerCase();
  let h = x;
  if (!HOST_RE.test(h)) {
    try {
      h = new URL(SCHEME_RE.test(x) ? x : `http://${x.replace(/^\*\./, '')}`).hostname;
    } catch {
      return null;
    }
  }
  h = h.replace(/^\*\./, '').replace(/^\.+/, '').replace(/\.$/, '');
  if (!h || !HOST_RE.test(h)) return null;
  const labels = h.split('.');
  return labels.every((l) => l && !l.startsWith('-') && !l.endsWith('-')) ? h : null;
}

const FIELDS = ['provider', 'jevApiKey', 'jevEndpoint', 'jevModel', 'threshold', 'mode', 'denyList'];

export function createOptions({ chrome, doc }) {
  const $ = (id) => doc.getElementById(id);
  const el = Object.fromEntries([...FIELDS, 'form', 'save', 'test', 'status', 'testResult'].map((id) => [id, $(id)]));

  async function send(msg) {
    try {
      const res = await chrome.runtime.sendMessage(msg);
      return res === undefined ? null : res;
    } catch (e) {
      return { error: String(e?.message || e) };
    }
  }

  function setStatus(text, kind = 'info') {
    el.status.textContent = text;
    el.status.dataset.kind = kind;
  }

  function fill(s) {
    el.provider.value = s.provider;
    el.jevApiKey.value = s.jevApiKey || '';
    el.jevEndpoint.value = s.jevEndpoint || '';
    el.jevModel.value = s.jevModel || '';
    el.threshold.value = String(s.threshold);
    el.mode.value = s.mode;
    el.denyList.value = (s.denyList || []).join('\n');
  }

  function readForm() {
    const threshold = Number.parseFloat(el.threshold.value);
    if (!Number.isFinite(threshold)) throw new Error('Threshold must be a number between 0.5 and 0.99');
    const jevApiKey = el.jevApiKey.value.trim();
    const lines = el.denyList.value.split('\n').map((l) => l.trim()).filter(Boolean);
    const bad = lines.filter((l) => parseHost(l) === null);
    if (bad.length) throw new Error(`Not a host name: ${bad.join(', ')}`);
    const patch = {
      provider: el.provider.value,
      jevApiKey,
      threshold,
      mode: el.mode.value,
      denyList: [...new Set(lines.map(parseHost))]
    };
    // Empty endpoint field: keep the stored endpoint rather than saving an invalid one.
    const jevEndpoint = el.jevEndpoint.value.trim();
    if (jevEndpoint) patch.jevEndpoint = jevEndpoint;
    // Blank model field: keep the stored model (saveSettings also falls back to the default).
    const jevModel = el.jevModel.value.trim();
    if (jevModel) patch.jevModel = jevModel;
    return patch;
  }

  async function save() {
    let patch;
    try {
      patch = readForm();
    } catch (e) {
      setStatus(e.message, 'error');
      return;
    }
    el.save.disabled = true;
    setStatus('Saving…');
    try {
      const res = await send({ type: 'save-settings', patch });
      if (res?.ok) {
        if (res.settings) fill(res.settings);
        setStatus('Saved');
      } else {
        setStatus(res?.error || 'Save failed', 'error');
      }
    } finally {
      el.save.disabled = false;
    }
  }

  async function test() {
    el.test.disabled = true;
    el.testResult.textContent = 'Testing…';
    try {
      const res = await send({ type: 'test-provider' });
      el.testResult.textContent = JSON.stringify(res, null, 2);
    } finally {
      el.test.disabled = false;
    }
  }

  async function init() {
    el.form.addEventListener('submit', (e) => {
      e.preventDefault();
      save();
    });
    el.test.addEventListener('click', () => test());
    const s = await send({ type: 'get-settings' });
    if (!s || typeof s.error === 'string' || typeof s.provider !== 'string') {
      setStatus(`Could not load settings: ${s?.error || 'no response'}`, 'error');
      el.save.disabled = true;
      return;
    }
    fill(s);
  }

  return { init, save, test };
}

export const ready =
  typeof chrome !== 'undefined' && chrome?.runtime && typeof document !== 'undefined'
    ? createOptions({ chrome, doc: document }).init()
    : Promise.resolve();
