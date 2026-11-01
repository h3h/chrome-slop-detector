import { describe, it, expect } from 'vitest';
import { createChromeStub } from '../chrome-stub.js';
import { tryConsume, RATE_LIMIT, RATE_WINDOW_MS } from '../../src/lib/ratelimit.js';

describe('ratelimit', () => {
  it('allows 30 then blocks, then recovers after window', async () => {
    const s = createChromeStub().storage.local;
    for (let i = 0; i < RATE_LIMIT; i++) expect(await tryConsume(s, 1000)).toBe(true);
    expect(await tryConsume(s, 1000)).toBe(false);
    expect(await tryConsume(s, 1000 + RATE_WINDOW_MS + 1)).toBe(true);
  });
  it('is race-free under concurrency', async () => {
    const s = createChromeStub().storage.local;
    const res = await Promise.all(Array.from({ length: 31 }, () => tryConsume(s, 1000)));
    expect(res.filter(Boolean).length).toBe(30);
    expect((await s.get('rateLog')).rateLog.length).toBe(30);
  });
});
