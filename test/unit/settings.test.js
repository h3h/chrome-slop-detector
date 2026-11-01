import { describe, it, expect } from 'vitest';
import { createChromeStub } from '../chrome-stub.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, validateEndpoint } from '../../src/lib/settings.js';

describe('settings', () => {
  it('returns defaults when empty', async () => {
    const c = createChromeStub();
    expect(await loadSettings(c.storage.local)).toEqual(DEFAULT_SETTINGS);
  });
  it('merges stored over defaults', async () => {
    const c = createChromeStub();
    await c.storage.local.set({ settings: { threshold: 0.8 } });
    const s = await loadSettings(c.storage.local);
    expect(s.threshold).toBe(0.8);
    expect(s.provider).toBe('jev');
    expect(s.denyList).toEqual(DEFAULT_SETTINGS.denyList);
  });
  it('validateEndpoint', () => {
    expect(validateEndpoint('https://x.y/z').ok).toBe(true);
    expect(validateEndpoint('http://example.com')).toEqual({ ok: false, error: 'Endpoint must use https' });
    expect(validateEndpoint('http://127.0.0.1:8123/jev').ok).toBe(true);
    expect(validateEndpoint('http://localhost:1/x').ok).toBe(true);
    expect(validateEndpoint('not a url').ok).toBe(false);
  });
  it('rejects invalid values', async () => {
    const c = createChromeStub();
    await expect(saveSettings(c.storage.local, { threshold: 1.2 })).rejects.toThrow();
    await expect(saveSettings(c.storage.local, { provider: 'foo' })).rejects.toThrow();
    await expect(saveSettings(c.storage.local, { mode: 'x' })).rejects.toThrow();
    await expect(saveSettings(c.storage.local, { jevEndpoint: 'http://example.com' })).rejects.toThrow(/^Endpoint must use https$/);
  });
  it('normalizes denyList and persists', async () => {
    const c = createChromeStub();
    const s = await saveSettings(c.storage.local, { denyList: [' A.com ', '', 'a.com'] });
    expect(s.denyList).toEqual(['a.com']);
    expect((await loadSettings(c.storage.local)).denyList).toEqual(['a.com']);
  });
  it('ignores undefined and unknown keys, rejects non-array denyList', async () => {
    const c = createChromeStub();
    const s = await saveSettings(c.storage.local, { threshold: undefined, bogus: 1 });
    expect(s.threshold).toBe(DEFAULT_SETTINGS.threshold);
    expect('bogus' in s).toBe(false);
    await expect(saveSettings(c.storage.local, { denyList: 'a.com' })).rejects.toThrow('Deny list must be a list');
  });
  it('blank or non-string jevModel falls back to the default model', async () => {
    const c = createChromeStub();
    for (const jevModel of ['', '   ', null, 42]) {
      const s = await saveSettings(c.storage.local, { jevModel });
      expect(s.jevModel).toBe(DEFAULT_SETTINGS.jevModel);
    }
    expect((await saveSettings(c.storage.local, { jevModel: ' jev-latest ' })).jevModel).toBe('jev-latest');
    await c.storage.local.set({ settings: { jevModel: '' } });
    expect((await saveSettings(c.storage.local, { threshold: 0.9 })).jevModel).toBe(DEFAULT_SETTINGS.jevModel);
  });
  it('has no noticeAcknowledged field and drops it from stored settings on save', async () => {
    expect('noticeAcknowledged' in DEFAULT_SETTINGS).toBe(false);
    const c = createChromeStub();
    await c.storage.local.set({ settings: { noticeAcknowledged: true, jevApiKey: 'k' } });
    const s = await saveSettings(c.storage.local, { threshold: 0.9 });
    expect('noticeAcknowledged' in s).toBe(false);
    expect('noticeAcknowledged' in (await c.storage.local.get('settings')).settings).toBe(false);
    expect(s.jevApiKey).toBe('k');
  });
  it('loadSettings result is isolated from defaults', async () => {
    const c = createChromeStub();
    const s = await loadSettings(c.storage.local);
    s.denyList.push('mutated.example');
    expect(DEFAULT_SETTINGS.denyList).not.toContain('mutated.example');
  });
});
