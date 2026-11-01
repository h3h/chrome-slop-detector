// Flagged-page banner. All dynamic text goes through textContent; no HTML parsing of data.
import { videoIdFromUrl } from '../lib/youtube.js';

export const TAG = 'slop-flag-banner';

// Pages whose banner the user dismissed in this page's lifetime, keyed by dismissKey().
const dismissed = new Set();

const PROVIDER_LABELS = { jev: 'Jev', heuristic: 'Heuristic' };

const HOST_STYLE = {
  all: 'initial',
  display: 'block',
  position: 'fixed',
  top: '0',
  left: '0',
  right: '0',
  'z-index': '2147483647',
};

const SHADOW_CSS = `
.bar { box-sizing: border-box; display: flex; align-items: center; gap: 12px;
  padding: 8px 12px; background: #c62828; color: #fff;
  font: 14px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  box-shadow: 0 2px 6px rgba(0,0,0,.3); }
.text { flex: 1; min-width: 0; }
.main { font-weight: 600; }
.note { font-size: 12px; opacity: .9; }
button { all: unset; cursor: pointer; font-size: 20px; line-height: 1; padding: 2px 8px;
  border-radius: 4px; color: #fff; }
button:hover, button:focus-visible { background: rgba(255,255,255,.2); outline: none; }
`;

function currentUrl(doc) {
  return doc?.defaultView?.location?.href ?? doc?.location?.href ?? '';
}

// Video id on YouTube watch pages (so &t= etc. don't resurrect it), else the URL sans hash.
function dismissKey(url) {
  const vid = videoIdFromUrl(url);
  if (vid) return 'yt:' + vid;
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

function providerLabel(provider) {
  const p = String(provider ?? '');
  return PROVIDER_LABELS[p] ?? p;
}

function percent(p) {
  const n = Number(p);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function removeBanner(doc) {
  for (const el of doc.querySelectorAll(TAG)) el.remove();
}

// Only call for flagged views. Replaces any existing banner; returns null when the user
// already dismissed the banner for this URL.
export function renderBanner(doc, view) {
  const url = dismissKey(currentUrl(doc));
  removeBanner(doc);
  if (dismissed.has(url)) return null;

  const host = doc.createElement(TAG);
  host.setAttribute('data-state', 'flagged');
  for (const [k, v] of Object.entries(HOST_STYLE)) host.style.setProperty(k, v, 'important');

  const root = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = SHADOW_CSS;

  const bar = doc.createElement('div');
  bar.className = 'bar';
  bar.setAttribute('role', 'alert');

  const text = doc.createElement('div');
  text.className = 'text';
  const main = doc.createElement('div');
  main.className = 'main';
  const pct = percent(view?.aiProbability);
  main.textContent = `Likely AI-written — ${providerLabel(view?.provider)}${pct === null ? '' : ` ${pct}%`}`;
  const note = doc.createElement('div');
  note.className = 'note';
  note.textContent = 'Detectors make mistakes. Click the Slop Flag toolbar icon for details.';
  text.append(main, note);

  const close = doc.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => {
    dismissed.add(url);
    host.remove();
  });

  bar.append(text, close);
  root.append(style, bar);
  doc.documentElement.appendChild(host);
  return host;
}
