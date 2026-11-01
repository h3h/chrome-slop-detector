// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://news.example.com/a"}
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TAG, renderBanner, removeBanner } from '../../src/content/banner.js';

const view = (over = {}) => ({ state: 'flagged', provider: 'jev', aiProbability: 0.96, url: location.href, ts: 1, ...over });
const all = () => document.querySelectorAll(TAG);

let n = 0;
beforeEach(() => {
  removeBanner(document);
  // Fresh URL per test so module-level dismissals don't leak between tests.
  history.pushState({}, '', `/page-${++n}`);
});

describe('renderBanner', () => {
  it('renders a fixed host with an open shadow root and the copy', () => {
    const el = renderBanner(document, view());
    expect(el).toBe(document.querySelector(TAG));
    expect(el.parentNode).toBe(document.documentElement);
    expect(el.getAttribute('data-state')).toBe('flagged');
    expect(el.style.position).toBe('fixed');
    expect(el.style.zIndex).toBe('2147483647');
    expect(el.shadowRoot).not.toBeNull();
    const text = el.shadowRoot.textContent;
    expect(text).toContain('Likely AI-written — Jev 96%');
    expect(text).toContain('Detectors make mistakes. Click the Slop Flag toolbar icon for details.');
    expect(el.shadowRoot.querySelector('button[aria-label="Dismiss"]').textContent).toBe('×');
  });

  it('labels the heuristic provider and rounds the percent', () => {
    const el = renderBanner(document, view({ provider: 'heuristic', aiProbability: 0.9549 }));
    expect(el.shadowRoot.textContent).toContain('Likely AI-written — Heuristic 95%');
  });

  it('is idempotent', () => {
    renderBanner(document, view());
    renderBanner(document, view({ aiProbability: 0.97 }));
    expect(all()).toHaveLength(1);
    expect(all()[0].shadowRoot.textContent).toContain('97%');
  });

  it('dismiss removes it and suppresses re-render on the same URL only', () => {
    const el = renderBanner(document, view());
    el.shadowRoot.querySelector('button[aria-label="Dismiss"]').click();
    expect(all()).toHaveLength(0);
    expect(renderBanner(document, view())).toBeNull();
    expect(all()).toHaveLength(0);
    history.pushState({}, '', '/other-page');
    expect(renderBanner(document, view())).not.toBeNull();
    expect(all()).toHaveLength(1);
  });

  it('dismissal ignores the URL fragment', () => {
    renderBanner(document, view()).shadowRoot.querySelector('button[aria-label="Dismiss"]').click();
    history.pushState({}, '', location.pathname + '#later');
    expect(renderBanner(document, view())).toBeNull();
  });

  it('dismissal on a YouTube watch page is keyed by video id', async () => {
    vi.resetModules();
    const m = await import('../../src/content/banner.js');
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://www.youtube.com/watch?v=abc&t=1' });
    const d = dom.window.document;
    m.renderBanner(d, view()).shadowRoot.querySelector('button[aria-label="Dismiss"]').click();
    dom.window.history.pushState({}, '', '/watch?v=abc&t=99');
    expect(m.renderBanner(d, view())).toBeNull();
    dom.window.history.pushState({}, '', '/watch?v=other');
    expect(m.renderBanner(d, view())).not.toBeNull();
  });

  it('renders hostile provider/title as literal text', () => {
    const payload = '<img src=x onerror="window.__pwned=1">';
    const el = renderBanner(document, view({ provider: payload, title: payload }));
    expect(el.shadowRoot.querySelector('img')).toBeNull();
    expect(el.shadowRoot.textContent).toContain(payload);
    expect(window.__pwned).toBeUndefined();
  });
});

describe('removeBanner', () => {
  it('removes the host and is safe when absent', () => {
    renderBanner(document, view());
    removeBanner(document);
    expect(all()).toHaveLength(0);
    expect(() => removeBanner(document)).not.toThrow();
  });
});
