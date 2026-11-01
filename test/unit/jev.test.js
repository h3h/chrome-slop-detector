import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { classify, buildRequest, parseResponse, OPTIONS, QUESTION_ID, DEFAULT_MODEL } from '../../src/providers/jev.js';
import { ProviderError } from '../../src/providers/errors.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-1.13.0';
const input = { text: 'some text', kind: 'article', url: 'https://example.com/a', title: 'A' };
const jsonFetch = (body, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
const opts = (fetch, extra = {}) => ({ apiKey: 'k-123', endpoint: ENDPOINT, model: MODEL, fetch, ...extra });
const withAnswer = (answer) => ({ model: MODEL, answers: { [QUESTION_ID]: answer }, usage: { input_tokens: 1, output_tokens: 1 } });
const choice = (probabilities, extra = {}) => withAnswer({ type: 'choice', choice: 'ai_generated', confidence: 0.9, probabilities, ...extra });

async function expectCode(promise, code) {
  let err;
  try { await promise; } catch (e) { err = e; }
  expect(err).toBeInstanceOf(ProviderError);
  expect(err.code).toBe(code);
  return err;
}

describe('jev request', () => {
  it('posts JSON with bearer auth, model, state and a choice question map', async () => {
    const fetch = jsonFetch(fixture('jev-response.json'));
    await classify(input, opts(fetch));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer k-123');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.model).toBe(MODEL);
    expect(body.state).toBe('some text');
    expect(Object.keys(body.questions)).toEqual(['ai_authorship']);
    const q = body.questions.ai_authorship;
    expect(q.type).toBe('choice');
    expect(q.instructions.question).toMatch(/AI language model/);
    expect(q.instructions.ai_signs.length).toBeGreaterThan(0);
    expect(Object.keys(q.criteria)).toEqual(OPTIONS);
  });

  it('buildRequest sends only documented top-level fields', () => {
    expect(Object.keys(buildRequest({ text: 't', model: 'm' })).sort()).toEqual(['model', 'questions', 'state']);
  });
});

describe('jev response parsing', () => {
  it('parses the documented choice answer', async () => {
    const r = await classify(input, opts(jsonFetch(fixture('jev-response.json'))));
    expect(r.aiProbability).toBe(0.96);
    expect(r.provider).toBe('jev');
    expect(r.model).toBe(MODEL);
    expect(r.raw).toEqual(fixture('jev-response.json'));
  });
  it('reports the chosen option as selected', () => {
    expect(parseResponse(fixture('jev-response.json')).selected).toBe('ai_generated');
  });
  it.each([
    ['answer under another question id', { model: MODEL, answers: { other: choice({ ai_generated: 0.5 }).answers[QUESTION_ID] } }],
    ['non-choice answer type', withAnswer({ type: 'noul', noul: 0.9 })],
    ['probabilities missing', withAnswer({ type: 'choice', choice: 'ai_generated', confidence: 1 })],
    ['ai_generated missing', choice({ human_written: 1 })],
    ['top-level probabilities (old guessed shape)', { probabilities: { ai_generated: 0.9 } }],
  ])('rejects %s', (_, body) => {
    expect(() => parseResponse(body)).toThrow(ProviderError);
  });
  it('rejects unknown shape', async () => {
    await expectCode(classify(input, opts(jsonFetch({ foo: 1 }))), 'bad_response');
  });
  it('rejects out-of-range probability', async () => {
    await expectCode(classify(input, opts(jsonFetch(choice({ ai_generated: 1.4 })))), 'bad_response');
  });
  it('rejects non-JSON body', async () => {
    const fetch = vi.fn(async () => new Response('<html>oops</html>', { status: 200 }));
    await expectCode(classify(input, opts(fetch)), 'bad_response');
  });
  it('parseResponse throws ProviderError on null', () => {
    expect(() => parseResponse(null)).toThrow(ProviderError);
  });
});

describe('jev HTTP and transport errors', () => {
  it.each([[401, 'auth'], [403, 'auth'], [429, 'provider_rate_limit'], [529, 'provider_rate_limit'], [400, 'bad_response'], [422, 'bad_response'], [500, 'bad_response']])(
    'status %i -> %s', async (status, code) => {
      const err = await expectCode(classify(input, opts(jsonFetch({ error: 'x' }, status))), code);
      expect(err.status).toBe(status);
    });
  it('fetch rejection -> network', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expectCode(classify(input, opts(fetch)), 'network');
  });
  it('aborts after timeoutMs -> timeout', async () => {
    const fetch = vi.fn((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
      });
    }));
    await expectCode(classify(input, opts(fetch, { timeoutMs: 20 })), 'timeout');
  });
  it('missing api key -> auth without calling fetch', async () => {
    const fetch = jsonFetch(fixture('jev-response.json'));
    const err = await expectCode(classify(input, opts(fetch, { apiKey: '' })), 'auth');
    expect(err.message).toBe('No API key');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('jev raw trimming', () => {
  it('truncates raw over 2048 chars', async () => {
    const body = { ...fixture('jev-response.json'), explanation: 'x'.repeat(3000) };
    const r = await classify(input, opts(jsonFetch(body)));
    expect(r.raw).toEqual({ truncated: true, selected: 'ai_generated', aiProbability: 0.96 });
  });
});

describe('jev review fixes', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('exports DEFAULT_MODEL and uses it when model is omitted', async () => {
    expect(DEFAULT_MODEL).toBe('jev-1.13.0');
    expect(buildRequest({ text: 't' }).model).toBe('jev-1.13.0');
    const fetch = jsonFetch(fixture('jev-response.json'));
    const r = await classify(input, { apiKey: 'k', endpoint: ENDPOINT, fetch });
    expect(r.model).toBe('jev-1.13.0');
    expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe('jev-1.13.0');
  });

  it('fails closed on a non-numeric ai_generated probability', () => {
    expect(() => parseResponse(choice({ ai_generated: 'high' }))).toThrow(ProviderError);
  });

  it('truncated raw drops selected not in OPTIONS', async () => {
    const body = choice({ ai_generated: 0.5 }, { choice: 'x'.repeat(3000) });
    const r = await classify(input, opts(jsonFetch(body)));
    expect(r.raw).toEqual({ truncated: true, aiProbability: 0.5 });
  });

  it('cancels the body on non-2xx', async () => {
    const cancel = vi.fn(async () => { throw new Error('ignored'); });
    const fetch = vi.fn(async () => ({ ok: false, status: 500, body: { cancel }, text: async () => '' }));
    await expectCode(classify(input, opts(fetch)), 'bad_response');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('whitespace-only api key -> auth without calling fetch', async () => {
    const fetch = jsonFetch(fixture('jev-response.json'));
    await expectCode(classify(input, opts(fetch, { apiKey: '   \n\t' })), 'auth');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('external signal abort -> network', async () => {
    const ac = new AbortController();
    const fetch = vi.fn((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
      });
    }));
    const p = classify(input, opts(fetch, { signal: ac.signal, timeoutMs: 10000 }));
    ac.abort();
    await expectCode(p, 'network');
  });

  it('hanging res.text() -> timeout', async () => {
    const fetch = vi.fn(async (url, init) => ({
      ok: true, status: 200,
      text: () => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
        });
      }),
    }));
    await expectCode(classify(input, opts(fetch, { timeoutMs: 20 })), 'timeout');
  });

  it('clears its timer after success and after error', async () => {
    vi.useFakeTimers();
    await classify(input, opts(jsonFetch(fixture('jev-response.json'))));
    expect(vi.getTimerCount()).toBe(0);
    await expectCode(classify(input, opts(jsonFetch({ error: 'x' }, 500))), 'bad_response');
    expect(vi.getTimerCount()).toBe(0);
    await expectCode(classify(input, opts(jsonFetch({ foo: 1 }))), 'bad_response');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 429, 500])('api key never appears in error (status %i)', async (status) => {
    const key = 'sk-SECRET-abc123';
    const err = await expectCode(classify(input, opts(jsonFetch({ error: key }, status), { apiKey: key })),
      status === 401 ? 'auth' : status === 429 ? 'provider_rate_limit' : 'bad_response');
    expect(err.message).not.toContain(key);
    expect(JSON.stringify(err)).not.toContain(key);
  });
  it('api key never appears in network or bad_response errors', async () => {
    const key = 'sk-SECRET-abc123';
    const e1 = await expectCode(classify(input, opts(vi.fn(async () => { throw new TypeError(key); }), { apiKey: key })), 'network');
    const e2 = await expectCode(classify(input, opts(jsonFetch({ foo: key }), { apiKey: key })), 'bad_response');
    for (const e of [e1, e2]) {
      expect(e.message).not.toContain(key);
      expect(JSON.stringify(e)).not.toContain(key);
    }
  });
});
