// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://www.youtube.com/watch?v=vid123&t=5"}
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  MSG_NS,
  videoIdFromUrl,
  pickCaptionTrack,
  parseJson3,
  extractPlayerInfo,
  isValidReply,
  potFromUrl,
  withPot,
} from '../../src/lib/youtube.js';
import { requestPlayer, fetchTranscript, getYouTubeText } from '../../src/content/youtube-client.js';

const json3 = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../fixtures/yt-json3.json'), 'utf8'));

const TRACK_URL = 'https://www.youtube.com/api/timedtext?v=vid123&lang=en';

function playerResponse({ videoId = 'vid123', title = 'A title', desc = 'A description', tracks } = {}) {
  const pr = {
    videoDetails: { videoId, title, shortDescription: desc, author: 'someone', viewCount: '9' },
    streamingData: { formats: [{ url: 'https://example.invalid/stream' }] },
  };
  if (tracks) pr.captions = { playerCaptionsTracklistRenderer: { captionTracks: tracks } };
  return pr;
}

// jsdom's window.postMessage never sets event.source (it is always null) and does not
// structured-clone data. This shim reproduces browser same-window semantics (source ===
// window, cloned data, targetOrigin filtering) so the production `event.source === win`
// check is exercised as-is rather than bypassed.
const nativePostMessage = window.postMessage;
function installFaithfulPostMessage(intercept) {
  window.postMessage = function (data, targetOrigin) {
    if (targetOrigin !== '*' && new URL(targetOrigin).origin !== window.location.origin) return;
    const cloned = structuredClone(data);
    if (intercept && intercept(cloned)) return;
    setTimeout(() => {
      window.dispatchEvent(new MessageEvent('message', { data: cloned, source: window, origin: window.location.origin }));
    }, 0);
  };
}
function dispatchForged(data, source) {
  window.dispatchEvent(new MessageEvent('message', { data, source }));
}

function okFetch(body) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
}

describe('videoIdFromUrl', () => {
  it('reads v on youtube.com/watch', () => {
    expect(videoIdFromUrl('https://www.youtube.com/watch?v=abc123&t=10')).toBe('abc123');
    expect(videoIdFromUrl('https://m.youtube.com/watch?v=xyz')).toBe('xyz');
  });
  it('rejects shorts, other paths, other hosts and garbage', () => {
    expect(videoIdFromUrl('https://www.youtube.com/shorts/abc123')).toBeNull();
    expect(videoIdFromUrl('https://www.youtube.com/watch')).toBeNull();
    expect(videoIdFromUrl('https://www.youtube.com/results?v=abc')).toBeNull();
    expect(videoIdFromUrl('https://example.com/watch?v=abc123')).toBeNull();
    expect(videoIdFromUrl('https://notyoutube.com/watch?v=abc123')).toBeNull();
    expect(videoIdFromUrl('not a url')).toBeNull();
  });
});

describe('pickCaptionTrack', () => {
  const manualEn = { baseUrl: 'u1', languageCode: 'en' };
  const asrEn = { baseUrl: 'u2', languageCode: 'en', kind: 'asr' };
  const de = { baseUrl: 'u3', languageCode: 'de' };
  it('prefers manual english over asr english', () => {
    expect(pickCaptionTrack([asrEn, de, manualEn])).toEqual({ track: manualEn, asr: false });
  });
  it('accepts regional english', () => {
    const gb = { baseUrl: 'u4', languageCode: 'en-GB' };
    expect(pickCaptionTrack([de, gb])).toEqual({ track: gb, asr: false });
  });
  it('returns null with no english track', () => {
    expect(pickCaptionTrack([de])).toBeNull();
    expect(pickCaptionTrack([])).toBeNull();
    expect(pickCaptionTrack(undefined)).toBeNull();
  });
  it('falls back to asr english and flags it', () => {
    expect(pickCaptionTrack([de, asrEn])).toEqual({ track: asrEn, asr: true });
  });
});

describe('parseJson3', () => {
  it('joins segs within events and events with spaces, normalized', () => {
    expect(parseJson3(json3)).toBe('Hello world again');
  });
  it('returns empty string when there is nothing', () => {
    expect(parseJson3({})).toBe('');
    expect(parseJson3(null)).toBe('');
  });
});

describe('extractPlayerInfo', () => {
  it('extracts only the four fields, with captions', () => {
    const tracks = [{ baseUrl: TRACK_URL, languageCode: 'en', kind: 'asr', name: { simpleText: 'English' }, vssId: 'a.en' }];
    expect(extractPlayerInfo(playerResponse({ tracks }))).toEqual({
      videoId: 'vid123',
      title: 'A title',
      shortDescription: 'A description',
      captionTracks: [{ baseUrl: TRACK_URL, languageCode: 'en', kind: 'asr', name: 'English' }],
    });
  });
  it('defaults captionTracks to [] without captions', () => {
    expect(extractPlayerInfo(playerResponse())).toEqual({
      videoId: 'vid123',
      title: 'A title',
      shortDescription: 'A description',
      captionTracks: [],
    });
  });
  it('returns null without videoDetails', () => {
    expect(extractPlayerInfo(undefined)).toBeNull();
    expect(extractPlayerInfo({})).toBeNull();
  });
});

describe('isValidReply', () => {
  const data = { [MSG_NS]: 'n1', type: 'player' };
  it('requires same-window source, nonce and type', () => {
    expect(isValidReply({ source: window, data }, 'n1', window)).toBe(true);
    expect(isValidReply({ source: null, data }, 'n1', window)).toBe(false);
    expect(isValidReply({ source: {}, data }, 'n1', window)).toBe(false);
    expect(isValidReply({ source: window, data }, 'n2', window)).toBe(false);
    expect(isValidReply({ source: window, data: { ...data, type: 'get-player' } }, 'n1', window)).toBe(false);
    expect(isValidReply({ source: window, data: null }, 'n1', window)).toBe(false);
    expect(isValidReply({ source: window, data: 'str' }, 'n1', window)).toBe(false);
  });
});

describe('MAIN-world bridge round trip', () => {
  beforeEach(async () => {
    installFaithfulPostMessage();
    await import('../../src/content/yt-main.js');
  });
  afterEach(() => {
    window.postMessage = nativePostMessage;
    delete window.ytInitialPlayerResponse;
    document.body.replaceChildren();
  });

  it('confirms jsdom leaves event.source null (why the shim exists)', async () => {
    window.postMessage = nativePostMessage;
    const got = new Promise((resolve) => window.addEventListener('message', (e) => resolve(e), { once: true }));
    window.postMessage({ probe: 1 }, '*');
    expect((await got).source).toBeNull();
  });

  it('returns info from ytInitialPlayerResponse, never the full response', async () => {
    const tracks = [{ baseUrl: TRACK_URL, languageCode: 'en' }];
    window.ytInitialPlayerResponse = playerResponse({ tracks });
    const replies = [];
    const spy = (e) => { if (e.data?.type === 'player') replies.push(e.data); };
    window.addEventListener('message', spy);
    const info = await requestPlayer(window);
    window.removeEventListener('message', spy);
    expect(info).toEqual({
      videoId: 'vid123',
      title: 'A title',
      shortDescription: 'A description',
      captionTracks: [{ baseUrl: TRACK_URL, languageCode: 'en' }],
    });
    expect(Object.keys(replies[0]).sort()).toEqual([MSG_NS, 'captionTracks', 'shortDescription', 'title', 'type', 'videoId'].sort());
  });

  it('prefers movie_player.getPlayerResponse over the stale initial response', async () => {
    window.ytInitialPlayerResponse = playerResponse({ videoId: 'stale', title: 'Old' });
    const el = document.createElement('div');
    el.id = 'movie_player';
    el.getPlayerResponse = () => playerResponse({ videoId: 'fresh', title: 'New' });
    document.body.append(el);
    const info = await requestPlayer(window);
    expect(info.videoId).toBe('fresh');
    expect(info.title).toBe('New');
  });

  it('MAIN side ignores requests not from its own window', async () => {
    window.ytInitialPlayerResponse = playerResponse();
    const posted = vi.fn();
    window.postMessage = posted;
    dispatchForged({ [MSG_NS]: 'n', type: 'get-player' }, null);
    expect(posted).not.toHaveBeenCalled();
    dispatchForged({ [MSG_NS]: 'n', type: 'get-player' }, window);
    expect(posted).toHaveBeenCalledWith(expect.objectContaining({ [MSG_NS]: 'n', type: 'player', videoId: 'vid123' }), 'https://www.youtube.com');
  });

  it('times out to null when no player data exists', async () => {
    expect(await requestPlayer(window, { timeoutMs: 50 })).toBeNull();
  });

  it('removes its listener after resolving', async () => {
    window.ytInitialPlayerResponse = playerResponse();
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    await requestPlayer(window);
    const mine = add.mock.calls.find((c) => c[0] === 'message')[1];
    expect(remove.mock.calls.some((c) => c[0] === 'message' && c[1] === mine)).toBe(true);
    add.mockRestore();
    remove.mockRestore();
  });
});

describe('requestPlayer rejects forged replies', () => {
  afterEach(() => { window.postMessage = nativePostMessage; });

  it('posts the request to its own origin', async () => {
    const calls = [];
    window.postMessage = (data, origin) => calls.push([data, origin]);
    await requestPlayer(window, { timeoutMs: 10 });
    expect(calls).toHaveLength(1);
    expect(calls[0][0].type).toBe('get-player');
    expect(typeof calls[0][0][MSG_NS]).toBe('string');
    expect(calls[0][0][MSG_NS].length).toBeGreaterThan(10);
    expect(calls[0][1]).toBe('https://www.youtube.com');
  });

  it('ignores wrong nonce and foreign source, accepts only the valid one', async () => {
    const info = { videoId: 'vid123', title: 'T', shortDescription: 'D', captionTracks: [] };
    let nonce;
    installFaithfulPostMessage((data) => { nonce = data[MSG_NS]; return true; });
    const p = requestPlayer(window, { timeoutMs: 200 });
    dispatchForged({ [MSG_NS]: 'wrong', type: 'player', ...info, title: 'forged-nonce' }, window);
    dispatchForged({ [MSG_NS]: nonce, type: 'player', ...info, title: 'forged-source' }, null);
    dispatchForged({ [MSG_NS]: nonce, type: 'player', ...info }, window);
    expect(await p).toEqual(info);
  });

  it('times out to null when only forged replies arrive', async () => {
    let nonce;
    installFaithfulPostMessage((data) => { nonce = data[MSG_NS]; return true; });
    const p = requestPlayer(window, { timeoutMs: 50 });
    dispatchForged({ [MSG_NS]: 'wrong', type: 'player', videoId: 'vid123' }, window);
    dispatchForged({ [MSG_NS]: nonce, type: 'player', videoId: 'vid123' }, null);
    expect(await p).toBeNull();
  });
});

describe('fetchTranscript', () => {
  it('fetches baseUrl + &fmt=json3 with credentials and parses it', async () => {
    const f = okFetch(json3);
    expect(await fetchTranscript({ baseUrl: TRACK_URL }, f)).toBe('Hello world again');
    expect(f).toHaveBeenCalledWith(TRACK_URL + '&fmt=json3', expect.objectContaining({ credentials: 'include' }));
  });
  it('returns empty string on any failure', async () => {
    expect(await fetchTranscript({ baseUrl: TRACK_URL }, vi.fn(async () => { throw new Error('net'); }))).toBe('');
    expect(await fetchTranscript({ baseUrl: TRACK_URL }, vi.fn(async () => ({ ok: false, status: 404, json: async () => json3 })))).toBe('');
    expect(await fetchTranscript({ baseUrl: TRACK_URL }, vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('empty'); } })))).toBe('');
    expect(await fetchTranscript({}, okFetch(json3))).toBe('');
  });
  it('times out to empty string when the fetch never settles', async () => {
    const f = vi.fn((url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    expect(await fetchTranscript({ baseUrl: TRACK_URL }, f, { timeoutMs: 20 })).toBe('');
  });
  it('times out even when the fetch ignores the signal', async () => {
    const f = vi.fn(() => new Promise(() => {}));
    expect(await fetchTranscript({ baseUrl: TRACK_URL }, f, { timeoutMs: 20 })).toBe('');
  });
  it('honours an external abort signal and cleans up its listener', async () => {
    const ac = new AbortController();
    const remove = vi.spyOn(ac.signal, 'removeEventListener');
    const f = vi.fn(() => new Promise(() => {}));
    const p = fetchTranscript({ baseUrl: TRACK_URL }, f, { signal: ac.signal, timeoutMs: 10000 });
    ac.abort();
    expect(await p).toBe('');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    const pre = new AbortController();
    pre.abort();
    const g = okFetch(json3);
    expect(await fetchTranscript({ baseUrl: TRACK_URL }, g, { signal: pre.signal })).toBe('');
    expect(g).not.toHaveBeenCalled();
  });
  it('sets fmt=json3 via URL params, replacing any existing fmt', async () => {
    const f = okFetch(json3);
    await fetchTranscript({ baseUrl: 'https://www.youtube.com/api/timedtext?v=a&fmt=srv3' }, f);
    expect(f.mock.calls[0][0]).toBe('https://www.youtube.com/api/timedtext?v=a&fmt=json3');
  });
  it('refuses non-youtube baseUrls without fetching', async () => {
    const f = okFetch(json3);
    expect(await fetchTranscript({ baseUrl: 'https://evil.example/x?y=1' }, f)).toBe('');
    expect(f).not.toHaveBeenCalled();
  });
});

describe('getYouTubeText', () => {
  beforeEach(async () => {
    installFaithfulPostMessage();
    await import('../../src/content/yt-main.js');
  });
  afterEach(() => {
    window.postMessage = nativePostMessage;
    delete window.ytInitialPlayerResponse;
  });

  it('uses the transcript when the fetch returns captions', async () => {
    window.ytInitialPlayerResponse = playerResponse({ tracks: [{ baseUrl: TRACK_URL, languageCode: 'en', kind: 'asr' }] });
    expect(await getYouTubeText(window, okFetch(json3))).toEqual({
      text: 'Hello world again', title: 'A title', source: 'transcript', asr: true, videoId: 'vid123',
    });
  });

  it('falls back to title + description when the fetch fails', async () => {
    window.ytInitialPlayerResponse = playerResponse({ tracks: [{ baseUrl: TRACK_URL, languageCode: 'en' }] });
    const f = vi.fn(async () => { throw new Error('net'); });
    expect(await getYouTubeText(window, f)).toEqual({
      text: 'A title\n\nA description', title: 'A title', source: 'description', asr: false, videoId: 'vid123',
    });
  });

  // E6: caption tracks exist but none is English -> the video is not English; send nothing.
  it("returns {skip:'lang'} without fetching when caption tracks exist but none is English", async () => {
    window.ytInitialPlayerResponse = playerResponse({
      tracks: [{ baseUrl: TRACK_URL, languageCode: 'de' }, { baseUrl: TRACK_URL, languageCode: 'fr', kind: 'asr' }],
    });
    const f = okFetch(json3);
    expect(await getYouTubeText(window, f)).toEqual({ skip: 'lang' });
    expect(f).not.toHaveBeenCalled();
  });

  it('returns null when the player bridge never answers', async () => {
    // No ytInitialPlayerResponse and no #movie_player: the MAIN script sends no reply.
    const f = okFetch(json3);
    expect(await getYouTubeText(window, f, { requestTimeoutMs: 20 })).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  // The MAIN script filters malformed tracks, but the client must not rely on it (a reply can
  // be forged by page script), so these reply directly with raw tracks.
  function replyWithTracks(captionTracks) {
    installFaithfulPostMessage((data) => {
      if (data?.type !== 'get-player') return false;
      setTimeout(() => dispatchForged({
        [MSG_NS]: data[MSG_NS], type: 'player', videoId: 'vid123', title: 'A title', shortDescription: 'A description', captionTracks,
      }, window), 0);
      return true;
    });
  }

  it('malformed tracks with no well-formed non-English one fall back to the description', async () => {
    replyWithTracks([{ languageCode: 'en' }, { baseUrl: TRACK_URL }, { baseUrl: TRACK_URL, languageCode: 7 }, null]);
    const f = okFetch(json3);
    expect(await getYouTubeText(window, f)).toMatchObject({ source: 'description', text: 'A title\n\nA description' });
    expect(f).not.toHaveBeenCalled();
  });

  it("a well-formed non-English track next to a malformed English one skips as 'lang'", async () => {
    replyWithTracks([{ languageCode: 'en' }, { baseUrl: TRACK_URL, languageCode: 'es' }]);
    const f = okFetch(json3);
    expect(await getYouTubeText(window, f)).toEqual({ skip: 'lang' });
    expect(f).not.toHaveBeenCalled();
  });

  it('falls back to description when there are no caption tracks', async () => {
    window.ytInitialPlayerResponse = playerResponse();
    const f = okFetch(json3);
    expect(await getYouTubeText(window, f)).toEqual({
      text: 'A title\n\nA description', title: 'A title', source: 'description', asr: false, videoId: 'vid123',
    });
    expect(f).not.toHaveBeenCalled();
  });

  it('falls back to description when the English track returns no text', async () => {
    window.ytInitialPlayerResponse = playerResponse({ tracks: [{ baseUrl: TRACK_URL, languageCode: 'en' }] });
    const f = okFetch({ events: [] });
    const r = await getYouTubeText(window, f);
    expect(r).toMatchObject({ source: 'description', asr: false });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('returns null after retrying when the reply videoId keeps not matching the URL', async () => {
    window.ytInitialPlayerResponse = playerResponse({ videoId: 'other' });
    const requests = vi.fn();
    const spy = (e) => { if (e.data?.type === 'get-player') requests(); };
    window.addEventListener('message', spy);
    const r = await getYouTubeText(window, okFetch(json3), { retryDelayMs: 1 });
    window.removeEventListener('message', spy);
    expect(r).toBeNull();
    expect(requests).toHaveBeenCalledTimes(3);
  });

  it('retries a mismatched reply and succeeds once the player catches up', async () => {
    let n = 0;
    const el = document.createElement('div');
    el.id = 'movie_player';
    el.getPlayerResponse = () => playerResponse({ videoId: n++ === 0 ? 'previous' : 'vid123' });
    document.body.append(el);
    try {
      const r = await getYouTubeText(window, okFetch(json3), { retryDelayMs: 1 });
      expect(r).toMatchObject({ videoId: 'vid123', source: 'description' });
      expect(n).toBe(2);
    } finally {
      el.remove();
    }
  });

  it('returns null when the URL changes while the transcript loads', async () => {
    window.ytInitialPlayerResponse = playerResponse({ tracks: [{ baseUrl: TRACK_URL, languageCode: 'en' }] });
    const original = window.location.href;
    const f = vi.fn(async () => {
      window.history.replaceState(null, '', '/watch?v=navigated');
      return { ok: true, status: 200, json: async () => json3 };
    });
    try {
      expect(await getYouTubeText(window, f)).toBeNull();
    } finally {
      window.history.replaceState(null, '', original);
    }
  });

  it('forwards the abort signal and returns null when aborted', async () => {
    window.ytInitialPlayerResponse = playerResponse({ tracks: [{ baseUrl: TRACK_URL, languageCode: 'en' }] });
    const ac = new AbortController();
    const f = vi.fn((url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      setTimeout(() => ac.abort(), 5);
    }));
    expect(await getYouTubeText(window, f, { signal: ac.signal })).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('potFromUrl / withPot', () => {
  const cap = 'https://www.youtube.com/api/timedtext?v=vid123&lang=en&pot=Mn-Tok_en%3D&c=WEB';
  it('reads pot from a timedtext URL for the same video', () => {
    expect(potFromUrl(cap, 'vid123')).toBe('Mn-Tok_en=');
  });
  it('rejects other videos, other paths, other hosts, missing or malformed pot', () => {
    expect(potFromUrl(cap, 'other')).toBeNull();
    expect(potFromUrl(cap.replace('/api/timedtext', '/api/other'), 'vid123')).toBeNull();
    expect(potFromUrl(cap.replace('www.youtube.com', 'evil.example'), 'vid123')).toBeNull();
    expect(potFromUrl(TRACK_URL, 'vid123')).toBeNull();
    expect(potFromUrl(TRACK_URL + '&pot=a%26b', 'vid123')).toBeNull();
    expect(potFromUrl('not a url', 'vid123')).toBeNull();
  });
  it('withPot adds pot and c=WEB, keeping the rest', () => {
    const u = new URL(withPot(TRACK_URL, 'TOK'));
    expect(u.searchParams.get('pot')).toBe('TOK');
    expect(u.searchParams.get('c')).toBe('WEB');
    expect(u.searchParams.get('lang')).toBe('en');
  });
});

describe('getYouTubeText proof-of-origin retry', () => {
  const POT = 'PoToken_123-abc';
  // YouTube answers a timedtext request without pot with 200 and an empty body.
  const emptyThenCaptions = () => vi.fn(async (url) => {
    const has = new URL(url).searchParams.has('pot');
    return { ok: true, status: 200, json: async () => { if (!has) throw new SyntaxError('empty'); return json3; } };
  });
  let observers;
  const NativePO = globalThis.PerformanceObserver;

  beforeEach(async () => {
    installFaithfulPostMessage();
    await import('../../src/content/yt-main.js');
    window.ytInitialPlayerResponse = playerResponse({ tracks: [{ baseUrl: TRACK_URL, languageCode: 'en', kind: 'asr' }] });
    observers = [];
    globalThis.PerformanceObserver = class {
      constructor(cb) { this.cb = cb; this.disconnect = vi.fn(); observers.push(this); }
      observe() {}
    };
    localStorage.clear();
  });
  afterEach(() => {
    window.postMessage = nativePostMessage;
    globalThis.PerformanceObserver = NativePO;
    delete window.ytInitialPlayerResponse;
    document.body.replaceChildren();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  const emitPot = () => {
    const entry = { name: `${TRACK_URL}&pot=${POT}&c=WEB` };
    for (const o of observers) o.cb({ getEntries: () => [entry] });
  };
  function mountPlayer(prior = {}) {
    const el = document.createElement('div');
    el.id = 'movie_player';
    el.getOption = vi.fn(() => prior);
    el.loadModule = vi.fn();
    el.unloadModule = vi.fn();
    el.setOption = vi.fn((mod, key, val) => {
      if (val?.languageCode === 'en' && !el.toggled) {
        el.toggled = true;
        localStorage.setItem('yt-player-caption-sticky-language', '{"data":"en"}');
        localStorage.setItem('yt-player-caption-persistence', '{"data":"true"}');
        setTimeout(emitPot, 0);
      }
    });
    document.body.append(el);
    return el;
  }

  it('reuses a pot from a timedtext request the player already made, without touching the player', async () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ name: `${TRACK_URL}&pot=${POT}&c=WEB` }]);
    const el = mountPlayer();
    const f = emptyThenCaptions();
    const r = await getYouTubeText(window, f);
    expect(r).toMatchObject({ text: 'Hello world again', source: 'transcript', asr: true });
    const second = new URL(f.mock.calls[1][0]);
    expect(second.searchParams.get('pot')).toBe(POT);
    expect(second.searchParams.get('c')).toBe('WEB');
    expect(el.setOption).not.toHaveBeenCalled();
  });

  it('briefly enables the caption track to capture a pot, then restores captions and storage', async () => {
    localStorage.setItem('yt-player-caption-persistence', '{"data":"false"}');
    const el = mountPlayer({});
    const f = emptyThenCaptions();
    const r = await getYouTubeText(window, f);
    expect(r).toMatchObject({ text: 'Hello world again', source: 'transcript' });
    expect(el.setOption).toHaveBeenCalledWith('captions', 'track', { languageCode: 'en' });
    expect(el.setOption).toHaveBeenLastCalledWith('captions', 'track', {});
    expect(el.unloadModule).toHaveBeenCalledWith('captions');
    expect(localStorage.getItem('yt-player-caption-sticky-language')).toBeNull();
    expect(localStorage.getItem('yt-player-caption-persistence')).toBe('{"data":"false"}');
    expect(observers[0].disconnect).toHaveBeenCalled();
  });

  it('puts back a caption track that was already selected', async () => {
    const prior = { languageCode: 'en', kind: 'asr' };
    const el = mountPlayer(prior);
    await getYouTubeText(window, emptyThenCaptions());
    expect(el.setOption).toHaveBeenLastCalledWith('captions', 'track', prior);
    expect(el.unloadModule).not.toHaveBeenCalled();
  });

  it('restores the player and falls back to the description when no pot arrives', async () => {
    const el = mountPlayer({});
    el.setOption = vi.fn();
    const f = emptyThenCaptions();
    const r = await getYouTubeText(window, f, { potTimeoutMs: 30 });
    expect(r).toMatchObject({ source: 'description' });
    expect(f).toHaveBeenCalledTimes(1);
    expect(el.setOption).toHaveBeenLastCalledWith('captions', 'track', {});
  });

  it('ignores a malformed pot', async () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ name: `${TRACK_URL}&pot=bad%20token` }]);
    const f = emptyThenCaptions();
    const r = await getYouTubeText(window, f, { potTimeoutMs: 30 });
    expect(r).toMatchObject({ source: 'description' });
    expect(f).toHaveBeenCalledTimes(1);
  });
});
