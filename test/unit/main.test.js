// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { start } from '../../src/content/main.js';
import { TAG } from '../../src/content/banner.js';
import { createChromeStub } from '../chrome-stub.js';
import { DEFAULT_DENY } from '../../src/lib/denylist.js';

const fixture = (name) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../fixtures', name), 'utf8');
const parse = (html) => new DOMParser().parseFromString(html, 'text/html');
const flush = () => new Promise((r) => setTimeout(r, 0));
const until = async (fn) => {
  for (let i = 0; i < 50 && !fn(); i++) await flush();
};

function fakeWin(href) {
  const win = Object.assign(new EventTarget(), { location: { href } });
  win.top = win;
  return win;
}

function setup({ href = 'https://news.example.com/a', html = fixture('article.html'), settings = {}, view } = {}) {
  const chrome = createChromeStub();
  const s = { mode: 'auto', denyList: [...DEFAULT_DENY], ...settings };
  const seen = [];
  const respond = view ?? ((msg) => ({ state: 'flagged', provider: 'jev', aiProbability: 0.96, url: msg.url, ts: 1 }));
  chrome.runtime.sendMessage = vi.fn(async (msg) => {
    seen.push(msg.type);
    if (msg.type === 'get-settings') throw new Error('content scripts must not request get-settings');
    if (msg.type === 'get-content-config') return { mode: s.mode, denyList: s.denyList };
    if (msg.type === 'classify') return respond(msg);
    return undefined;
  });
  const win = fakeWin(href);
  const doc = parse(html);
  return { chrome, win, doc };
}
const classifyCalls = (chrome) => chrome.runtime.sendMessage.mock.calls.map((c) => c[0]).filter((m) => m.type === 'classify');

describe('content main — articles', () => {
  it('auto mode classifies a readerable article and renders the banner', async () => {
    const { chrome, win, doc } = setup();
    start({ chrome, win, doc, fetchFn: vi.fn() });
    await until(() => doc.querySelector(TAG));
    const types = chrome.runtime.sendMessage.mock.calls.map((c) => c[0].type);
    expect(types).toContain('get-content-config');
    expect(types).not.toContain('get-settings');
    const [msg] = classifyCalls(chrome);
    expect(msg).toMatchObject({ type: 'classify', kind: 'article', source: 'article', asr: false, force: false, url: 'https://news.example.com/a' });
    expect(msg.text).toContain('Harbor Town Reopens');
    expect(doc.querySelector(TAG)).not.toBeNull();
  });

  it('removes the banner for a non-flagged view', async () => {
    const { chrome, win, doc } = setup({ view: () => ({ state: 'clear', provider: 'jev', aiProbability: 0.1 }) });
    start({ chrome, win, doc, fetchFn: vi.fn() });
    await until(() => classifyCalls(chrome).length);
    await flush();
    expect(doc.querySelector(TAG)).toBeNull();
  });

  it('manual mode waits for run-check and acknowledges it', async () => {
    const { chrome, win, doc } = setup({ settings: { mode: 'manual' } });
    start({ chrome, win, doc, fetchFn: vi.fn() });
    await flush();
    await flush();
    expect(classifyCalls(chrome)).toHaveLength(0);
    const sendResponse = vi.fn();
    expect(chrome._listeners.message[0]({ type: 'run-check', force: true }, {}, sendResponse)).toBe(true);
    await until(() => classifyCalls(chrome).length);
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, skipped: null });
    expect(classifyCalls(chrome)[0].force).toBe(true);
  });

  it('skips deny-listed hosts, non-English pages and non-articles', async () => {
    for (const opts of [
      { href: 'https://mail.google.com/x' },
      { html: fixture('article.html').replace('lang="en"', 'lang="de"') },
      { html: fixture('homepage.html') },
    ]) {
      const { chrome, win, doc } = setup(opts);
      start({ chrome, win, doc, fetchFn: vi.fn() });
      await flush();
      await flush();
      expect(classifyCalls(chrome)).toHaveLength(0);
    }
  });

  it('does nothing in a subframe', async () => {
    const { chrome, win, doc } = setup();
    win.top = {};
    expect(start({ chrome, win, doc, fetchFn: vi.fn() })).toBeNull();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('stops quietly when the extension context is invalidated', async () => {
    const { chrome, win, doc } = setup();
    chrome.runtime.sendMessage = vi.fn(() => {
      delete chrome.runtime.id;
      throw new Error('Extension context invalidated.');
    });
    const removeListener = vi.fn();
    chrome.runtime.onMessage.removeListener = removeListener;
    const ctl = start({ chrome, win, doc, fetchFn: vi.fn() });
    await until(() => ctl.stopped);
    expect(ctl.stopped).toBe(true);
    expect(removeListener).toHaveBeenCalled();
    await ctl.run(true, 'manual');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('a transient send failure with a live context does not stop', async () => {
    const { chrome, win, doc } = setup();
    chrome.runtime.id = 'ext';
    chrome.runtime.sendMessage = vi.fn(async () => {
      throw new Error('Could not establish connection.');
    });
    const ctl = start({ chrome, win, doc, fetchFn: vi.fn() });
    await flush();
    await flush();
    expect(ctl.stopped).toBe(false);
  });
});

describe('content main — YouTube', () => {
  const ytHtml = '<html lang="en"><body></body></html>';
  const ytText = (videoId) => ({ text: 'transcript words', title: 'T', source: 'transcript', asr: true, videoId });

  it('classifies once per video and re-applies the last view on same-video navigation', async () => {
    const { chrome, win, doc } = setup({ href: 'https://www.youtube.com/watch?v=aaa', html: ytHtml });
    const getText = vi.fn(async (w) => ytText(new URL(w.location.href).searchParams.get('v')));
    start({ chrome, win, doc, fetchFn: vi.fn(), getText });
    await until(() => doc.querySelector(TAG));
    expect(classifyCalls(chrome)[0]).toMatchObject({ kind: 'youtube', source: 'transcript', asr: true });

    doc.dispatchEvent(new Event('yt-navigate-finish'));
    expect(doc.querySelector(TAG)).toBeNull();
    await until(() => doc.querySelector(TAG));
    expect(getText).toHaveBeenCalledTimes(1);
    expect(classifyCalls(chrome)).toHaveLength(1);

    win.location.href = 'https://www.youtube.com/watch?v=bbb';
    doc.dispatchEvent(new Event('yt-navigate-finish'));
    await until(() => classifyCalls(chrome).length === 2);
    expect(getText).toHaveBeenCalledTimes(2);
  });

  it('aborts the in-flight extraction on navigation and does not record a null result', async () => {
    const { chrome, win, doc } = setup({ href: 'https://www.youtube.com/watch?v=aaa', html: ytHtml });
    const signals = [];
    let calls = 0;
    const getText = vi.fn((w, f, opts) => {
      signals.push(opts.signal);
      calls++;
      if (calls === 1) {
        // Never resolves until aborted, then resolves null like getYouTubeText.
        return new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve(null)));
      }
      return Promise.resolve(ytText('aaa'));
    });
    start({ chrome, win, doc, fetchFn: vi.fn(), getText });
    await until(() => signals.length === 1);
    doc.dispatchEvent(new Event('yt-navigate-finish'));
    expect(signals[0].aborted).toBe(true);
    await until(() => classifyCalls(chrome).length === 1);
    expect(getText).toHaveBeenCalledTimes(2);
    expect(classifyCalls(chrome)).toHaveLength(1);
  });

  it('a null result (player mismatch) leaves the video retryable', async () => {
    const { chrome, win, doc } = setup({ href: 'https://www.youtube.com/watch?v=aaa', html: ytHtml });
    const getText = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(ytText('aaa'));
    start({ chrome, win, doc, fetchFn: vi.fn(), getText });
    await until(() => getText.mock.calls.length === 1);
    await flush();
    expect(classifyCalls(chrome)).toHaveLength(0);
    doc.dispatchEvent(new Event('yt-navigate-finish'));
    await until(() => classifyCalls(chrome).length === 1);
    expect(getText).toHaveBeenCalledTimes(2);
  });

  describe('run-check reply waits for the YouTube text', () => {
    async function runCheck(getText) {
      const { chrome, win, doc } = setup({ href: 'https://www.youtube.com/watch?v=aaa', html: ytHtml, settings: { mode: 'manual' } });
      start({ chrome, win, doc, fetchFn: vi.fn(), getText });
      const sendResponse = vi.fn();
      chrome._listeners.message[0]({ type: 'run-check', force: false }, {}, sendResponse);
      return { chrome, sendResponse };
    }

    it("replies skipped 'lang' when getYouTubeText reports non-English captions", async () => {
      const { chrome, sendResponse } = await runCheck(vi.fn(async () => ({ skip: 'lang' })));
      await until(() => sendResponse.mock.calls.length);
      expect(sendResponse).toHaveBeenCalledWith({ ok: true, skipped: 'lang' });
      expect(sendResponse).toHaveBeenCalledTimes(1);
      expect(classifyCalls(chrome)).toHaveLength(0);
    });

    it("replies skipped 'unavailable' on a null result (player mismatch or no player reply)", async () => {
      const { chrome, sendResponse } = await runCheck(vi.fn(async () => null));
      await until(() => sendResponse.mock.calls.length);
      expect(sendResponse).toHaveBeenCalledWith({ ok: true, skipped: 'unavailable' });
      expect(classifyCalls(chrome)).toHaveLength(0);
    });

    it('replies skipped null only after the text resolves, then classifies', async () => {
      let resolve;
      const getText = vi.fn(() => new Promise((r) => { resolve = r; }));
      const { chrome, sendResponse } = await runCheck(getText);
      await until(() => getText.mock.calls.length);
      await flush();
      expect(sendResponse).not.toHaveBeenCalled();
      resolve(ytText('aaa'));
      await until(() => sendResponse.mock.calls.length);
      expect(sendResponse).toHaveBeenCalledWith({ ok: true, skipped: null });
      await until(() => classifyCalls(chrome).length);
      expect(classifyCalls(chrome)).toHaveLength(1);
    });

    it('a skip result leaves the video retryable', async () => {
      const getText = vi.fn().mockResolvedValueOnce({ skip: 'lang' }).mockResolvedValueOnce(ytText('aaa'));
      const { chrome, win, doc } = setup({ href: 'https://www.youtube.com/watch?v=aaa', html: ytHtml });
      start({ chrome, win, doc, fetchFn: vi.fn(), getText });
      await until(() => getText.mock.calls.length === 1);
      await flush();
      doc.dispatchEvent(new Event('yt-navigate-finish'));
      await until(() => classifyCalls(chrome).length === 1);
      expect(getText).toHaveBeenCalledTimes(2);
    });
  });

  it('ignores a non-English <html lang> on watch pages (UI language, not video language)', async () => {
    const { chrome, win, doc } = setup({ href: 'https://www.youtube.com/watch?v=aaa', html: '<html lang="de-DE"><body></body></html>' });
    const getText = vi.fn(async () => ytText('aaa'));
    start({ chrome, win, doc, fetchFn: vi.fn(), getText });
    await until(() => classifyCalls(chrome).length === 1);
    expect(classifyCalls(chrome)[0].kind).toBe('youtube');
  });

  it('force re-checks the same video', async () => {
    const { chrome, win, doc } = setup({ href: 'https://www.youtube.com/watch?v=aaa', html: ytHtml });
    const getText = vi.fn(async () => ytText('aaa'));
    const ctl = start({ chrome, win, doc, fetchFn: vi.fn(), getText });
    await until(() => classifyCalls(chrome).length === 1);
    await ctl.run(true, 'manual');
    expect(classifyCalls(chrome)).toHaveLength(2);
    expect(classifyCalls(chrome)[1].force).toBe(true);
  });
});

describe('content main — page lifecycle', () => {
  const pageshow = (persisted) => Object.assign(new Event('pageshow'), { persisted });

  it('re-checks an article on bfcache restore without forcing', async () => {
    const { chrome, win, doc } = setup();
    start({ chrome, win, doc, fetchFn: vi.fn() });
    await until(() => classifyCalls(chrome).length === 1);
    win.dispatchEvent(pageshow(false));
    await flush();
    await flush();
    expect(classifyCalls(chrome)).toHaveLength(1);
    win.dispatchEvent(pageshow(true));
    await until(() => classifyCalls(chrome).length === 2);
    expect(classifyCalls(chrome)[1].force).toBe(false);
  });

  it('bfcache restore bypasses the YouTube videoId dedupe', async () => {
    const { chrome, win, doc } = setup({ href: 'https://www.youtube.com/watch?v=aaa', html: '<html lang="en"><body></body></html>' });
    const getText = vi.fn(async () => ({ text: 't', title: 'T', source: 'description', asr: false, videoId: 'aaa' }));
    start({ chrome, win, doc, fetchFn: vi.fn(), getText });
    await until(() => classifyCalls(chrome).length === 1);
    win.dispatchEvent(pageshow(true));
    await until(() => classifyCalls(chrome).length === 2);
    expect(classifyCalls(chrome)[1].force).toBe(false);
  });

  it('manual mode: bfcache restore re-checks only a page the user already checked', async () => {
    const { chrome, win, doc } = setup({ settings: { mode: 'manual' } });
    start({ chrome, win, doc, fetchFn: vi.fn() });
    win.dispatchEvent(pageshow(true));
    await flush();
    await flush();
    expect(classifyCalls(chrome)).toHaveLength(0);
    chrome._listeners.message[0]({ type: 'run-check', force: false }, {}, () => {});
    await until(() => classifyCalls(chrome).length === 1);
    win.dispatchEvent(pageshow(true));
    await until(() => classifyCalls(chrome).length === 2);
  });

  it('defers the initial run while prerendering', async () => {
    const { chrome, win, doc } = setup();
    Object.defineProperty(doc, 'prerendering', { configurable: true, value: true });
    start({ chrome, win, doc, fetchFn: vi.fn() });
    await flush();
    await flush();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    Object.defineProperty(doc, 'prerendering', { configurable: true, value: false });
    doc.dispatchEvent(new Event('prerenderingchange'));
    await until(() => classifyCalls(chrome).length === 1);
  });

  it('only a flagged view renders; pending/unknown remove the banner', async () => {
    const states = ['flagged', 'pending'];
    const { chrome, win, doc } = setup({
      view: () => ({ state: states.shift() ?? 'unknown', provider: 'jev', aiProbability: 0.96, threshold: 0.9, effectiveThreshold: 0.9 }),
    });
    const ctl = start({ chrome, win, doc, fetchFn: vi.fn() });
    await until(() => doc.querySelector(TAG));
    await ctl.run(true, 'manual');
    expect(doc.querySelector(TAG)).toBeNull();
  });
});

describe('content main — review fixes', () => {
  const ytHtml = '<html lang="en"><body></body></html>';
  const ytText = (videoId) => ({ text: 'transcript words', title: 'T', source: 'transcript', asr: false, videoId });

  function gatedYouTube() {
    let release;
    const gate = new Promise((r) => (release = r));
    const env = setup({ href: 'https://www.youtube.com/watch?v=aaa', html: ytHtml });
    const inner = env.chrome.runtime.sendMessage.getMockImplementation();
    env.chrome.runtime.sendMessage = vi.fn(async (msg) => {
      if (msg.type === 'classify') await gate;
      return inner(msg);
    });
    const getText = vi.fn(async () => ytText('aaa'));
    return { ...env, getText, release };
  }

  it('same-video yt-navigate-finish during an in-flight classify still shows the banner', async () => {
    const { chrome, win, doc, getText, release } = gatedYouTube();
    start({ chrome, win, doc, fetchFn: vi.fn(), getText });
    await until(() => classifyCalls(chrome).length === 1);
    doc.dispatchEvent(new Event('yt-navigate-finish'));
    for (let i = 0; i < 5; i++) await flush();
    release();
    await until(() => doc.querySelector(TAG));
    expect(doc.querySelector(TAG)).not.toBeNull();
    expect(classifyCalls(chrome)).toHaveLength(1);
    expect(getText).toHaveBeenCalledTimes(1);
  });

  it('run-check force:false during an in-flight classify still shows the banner', async () => {
    const { chrome, win, doc, getText, release } = gatedYouTube();
    start({ chrome, win, doc, fetchFn: vi.fn(), getText });
    await until(() => classifyCalls(chrome).length === 1);
    const sendResponse = vi.fn();
    chrome._listeners.message[0]({ type: 'run-check', force: false }, {}, sendResponse);
    await until(() => sendResponse.mock.calls.length);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, skipped: null });
    release();
    await until(() => doc.querySelector(TAG));
    expect(doc.querySelector(TAG)).not.toBeNull();
    expect(classifyCalls(chrome)).toHaveLength(1);
  });

  it('non-YouTube SPA navigation removes the banner and aborts the in-flight run', async () => {
    const { chrome, win, doc } = setup();
    win.navigation = new EventTarget();
    start({ chrome, win, doc, fetchFn: vi.fn() });
    await until(() => doc.querySelector(TAG));
    // Hash-only change: same page, banner stays.
    win.location.href = 'https://news.example.com/a#comments';
    win.navigation.dispatchEvent(new Event('navigatesuccess'));
    expect(doc.querySelector(TAG)).not.toBeNull();
    win.location.href = 'https://news.example.com/b';
    win.navigation.dispatchEvent(new Event('navigatesuccess'));
    expect(doc.querySelector(TAG)).toBeNull();
    expect(classifyCalls(chrome)).toHaveLength(1);
  });

  it('a navigatesuccess mid-classify drops the stale reply', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const { chrome, win, doc } = setup();
    const inner = chrome.runtime.sendMessage.getMockImplementation();
    chrome.runtime.sendMessage = vi.fn(async (msg) => {
      if (msg.type === 'classify') await gate;
      return inner(msg);
    });
    win.navigation = new EventTarget();
    start({ chrome, win, doc, fetchFn: vi.fn() });
    await until(() => classifyCalls(chrome).length === 1);
    win.location.href = 'https://news.example.com/b';
    win.navigation.dispatchEvent(new Event('navigatesuccess'));
    release();
    for (let i = 0; i < 5; i++) await flush();
    expect(doc.querySelector(TAG)).toBeNull();
  });

  it('a hash change while classifying does not drop the result', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const { chrome, win, doc } = setup();
    const inner = chrome.runtime.sendMessage.getMockImplementation();
    chrome.runtime.sendMessage = vi.fn(async (msg) => {
      if (msg.type === 'classify') await gate;
      return inner(msg);
    });
    start({ chrome, win, doc, fetchFn: vi.fn() });
    await until(() => classifyCalls(chrome).length === 1);
    win.location.href = 'https://news.example.com/a#section-2';
    release();
    await until(() => doc.querySelector(TAG));
    expect(doc.querySelector(TAG)).not.toBeNull();
  });

  it('run-check replies with the skip reason', async () => {
    const cases = [
      [{ href: 'https://mail.google.com/x' }, 'denied'],
      [{ html: fixture('article.html').replace('lang="en"', 'lang="de"') }, 'lang'],
      [{ href: 'chrome://settings' }, 'scheme'],
      [{ html: fixture('homepage.html') }, 'not_article'],
    ];
    for (const [opts, reason] of cases) {
      const { chrome, win, doc } = setup({ ...opts, settings: { mode: 'manual' } });
      start({ chrome, win, doc, fetchFn: vi.fn() });
      const sendResponse = vi.fn();
      chrome._listeners.message[0]({ type: 'run-check', force: false }, {}, sendResponse);
      await until(() => sendResponse.mock.calls.length);
      expect(sendResponse).toHaveBeenCalledWith({ ok: true, skipped: reason });
      expect(classifyCalls(chrome)).toHaveLength(0);
    }
  });

  it('removes the banner when a run ends skipped as denied (Never check this site)', async () => {
    const denyList = [...DEFAULT_DENY];
    const { chrome, win, doc } = setup({ settings: { denyList } });
    start({ chrome, win, doc, fetchFn: vi.fn() });
    await until(() => doc.querySelector(TAG));
    expect(doc.querySelector(TAG)).not.toBeNull();
    denyList.push('news.example.com');
    const sendResponse = vi.fn();
    chrome._listeners.message[0]({ type: 'run-check', force: false }, {}, sendResponse);
    await until(() => sendResponse.mock.calls.length);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, skipped: 'denied' });
    expect(doc.querySelector(TAG)).toBeNull();
    expect(classifyCalls(chrome)).toHaveLength(1);
  });

  it('run-check replies no_text when Readability yields nothing', async () => {
    const mod = await import('../../src/content/extract.js');
    const { chrome, win, doc } = setup({ settings: { mode: 'manual' } });
    // Over the element cap: extractArticle bails out before cloning.
    const filler = doc.createElement('div');
    for (let i = 0; i <= mod.MAX_ELEMS; i++) filler.appendChild(doc.createElement('span'));
    doc.body.appendChild(filler);
    start({ chrome, win, doc, fetchFn: vi.fn() });
    const sendResponse = vi.fn();
    chrome._listeners.message[0]({ type: 'run-check', force: false }, {}, sendResponse);
    await until(() => sendResponse.mock.calls.length);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, skipped: 'no_text' });
    expect(classifyCalls(chrome)).toHaveLength(0);
  });
});
