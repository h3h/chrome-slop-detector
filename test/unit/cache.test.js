import { describe, it, expect } from 'vitest';
import { createChromeStub } from '../chrome-stub.js';
import { cacheKey, cacheGet, cachePut, CACHE_TTL_MS, CACHE_CAP } from '../../src/lib/cache.js';

describe('cache', () => {
  it('builds key', () => {
    expect(cacheKey({ provider: 'jev', model: 'm', textHash: 'h' })).toBe('jev|m|h');
    expect(cacheKey({ provider: 'heuristic', textHash: 'h' })).toBe('heuristic||h');
  });
  it('roundtrips', async () => {
    const s = createChromeStub().storage.local;
    await cachePut(s, 'k', { aiProbability: 0.9, raw: {}, source: 'jev', asr: false }, 1000);
    expect(await cacheGet(s, 'k', 2000)).toEqual({ aiProbability: 0.9, raw: {}, source: 'jev', asr: false, ts: 1000 });
    expect(await cacheGet(s, 'missing', 2000)).toBeNull();
  });
  it('expires', async () => {
    const s = createChromeStub().storage.local;
    await cachePut(s, 'k', { aiProbability: 0.9 }, 1000);
    expect(await cacheGet(s, 'k', 1000 + CACHE_TTL_MS + 1)).toBeNull();
  });
  it('caps entries keeping newest', async () => {
    const s = createChromeStub().storage.local;
    for (let i = 0; i < 502; i++) await cachePut(s, 'k' + i, { aiProbability: 0.5 }, 1000 + i);
    const { cache } = await s.get('cache');
    expect(Object.keys(cache).length).toBe(CACHE_CAP);
    expect(await cacheGet(s, 'k0', 2000)).toBeNull();
    expect(await cacheGet(s, 'k1', 2000)).toBeNull();
    expect(await cacheGet(s, 'k2', 2000)).not.toBeNull();
    expect(await cacheGet(s, 'k501', 2000)).not.toBeNull();
  });
  it('treats future ts as expired and survives concurrent puts', async () => {
    const s = createChromeStub().storage.local;
    await cachePut(s, 'f', { aiProbability: 0.9 }, 5000);
    expect(await cacheGet(s, 'f', 1000)).toBeNull();
    await Promise.all(Array.from({ length: 10 }, (_, i) => cachePut(s, 'c' + i, { aiProbability: 0.5 }, 6000 + i)));
    expect(Object.keys((await s.get('cache')).cache).filter((k) => k.startsWith('c')).length).toBe(10);
  });
});
