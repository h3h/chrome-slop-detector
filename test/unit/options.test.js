// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://ext.invalid/options/index.html"}
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_SETTINGS } from '../../src/lib/settings.js';
import { parseHost } from '../../src/options/options.js';

const HTML = readFileSync(resolve(import.meta.dirname, '../../src/options/index.html'), 'utf8');

async function load({ settings = structuredClone(DEFAULT_SETTINGS), onMessage } = {}) {
  document.documentElement.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').documentElement.innerHTML;
  const sent = [];
  globalThis.chrome = {
    runtime: {
      sendMessage: vi.fn(async (msg) => {
        sent.push(structuredClone(msg));
        const r = onMessage ? await onMessage(msg) : undefined;
        if (r !== undefined) return r;
        if (msg.type === 'get-settings') return settings;
        if (msg.type === 'save-settings') return { ok: true, settings: { ...settings, ...msg.patch } };
        return undefined;
      })
    }
  };
  vi.resetModules();
  const mod = await import('../../src/options/options.js');
  await mod.ready;
  return { sent };
}

const $ = (s) => document.querySelector(s);
const saves = (sent) => sent.filter((m) => m.type === 'save-settings');

describe('options', () => {
  it('fills the form from get-settings', async () => {
    await load({ settings: { ...DEFAULT_SETTINGS, jevApiKey: 'k1', threshold: 0.93, mode: 'manual' } });
    expect($('#provider').value).toBe('jev');
    expect($('#jevApiKey').type).toBe('password');
    expect($('#jevApiKey').value).toBe('k1');
    expect($('#jevEndpoint').value).toBe(DEFAULT_SETTINGS.jevEndpoint);
    expect($('#jevModel').value).toBe('jev-1.13.0');
    expect($('#threshold').value).toBe('0.93');
    expect($('#mode').value).toBe('manual');
    expect($('#denyList').value.split('\n')).toContain('mail.google.com');
    expect($('#notice').textContent).toMatch(/Auto/);
    expect($('#notice').textContent).toMatch(/unverified/);
  });

  it('shows the save error from the service worker', async () => {
    const { sent } = await load({
      onMessage: (m) => (m.type === 'save-settings' ? { ok: false, error: 'Endpoint must use https' } : undefined)
    });
    $('#jevEndpoint').value = 'http://example.com';
    $('#save').click();
    await vi.waitFor(() => expect($('#status').textContent).toBe('Endpoint must use https'));
    expect(saves(sent)[0].patch.jevEndpoint).toBe('http://example.com');
  });

  it('saves all fields; a non-empty key acknowledges the notice', async () => {
    const { sent } = await load();
    $('#provider').value = 'heuristic';
    $('#jevApiKey').value = '  key-123  ';
    $('#threshold').value = '0.8';
    $('#mode').value = 'manual';
    $('#denyList').value = 'Example.com\n\n  foo.org \nhttps://News.Site.com/a/b?c=1\nbar.net/path\nexample.com.\n';
    $('#save').click();
    await vi.waitFor(() => expect($('#status').textContent).toBe('Saved'));
    expect(saves(sent)[0].patch).toEqual({
      provider: 'heuristic',
      jevApiKey: 'key-123',
      jevEndpoint: DEFAULT_SETTINGS.jevEndpoint,
      jevModel: 'jev-1.13.0',
      threshold: 0.8,
      mode: 'manual',
      denyList: ['example.com', 'foo.org', 'news.site.com', 'bar.net'],
      noticeAcknowledged: true
    });
  });

  it('does not set noticeAcknowledged without a key', async () => {
    const { sent } = await load();
    $('#save').click();
    await vi.waitFor(() => expect(saves(sent)).toHaveLength(1));
    expect('noticeAcknowledged' in saves(sent)[0].patch).toBe(false);
  });

  it('rejects a non-numeric threshold without saving', async () => {
    const { sent } = await load();
    $('#threshold').value = '';
    $('#save').click();
    await vi.waitFor(() => expect($('#status').textContent).toMatch(/Threshold/));
    expect(saves(sent)).toHaveLength(0);
  });

  it('parseHost normalizes and validates host names', () => {
    expect(parseHost('.foo.com')).toBe('foo.com');
    expect(parseHost('..foo.com')).toBe('foo.com');
    expect(parseHost('*.foo.com')).toBe('foo.com');
    expect(parseHost('https://Foo.com/x')).toBe('foo.com');
    expect(parseHost('foo.com.')).toBe('foo.com');
    expect(parseHost('foo..com')).toBeNull();
    expect(parseHost('-foo.com')).toBeNull();
    expect(parseHost('foo-.com')).toBeNull();
    expect(parseHost('a.-b.com')).toBeNull();
    expect(parseHost('.')).toBeNull();
    expect(parseHost('*.')).toBeNull();
    expect(parseHost('my-site.co.uk')).toBe('my-site.co.uk');
  });

  it('rejects bad deny-list lines, lists them and does not save', async () => {
    const { sent } = await load();
    $('#denyList').value = 'good.com\nnot a host\n*.glob.com\nfoo..com\nhttps://ok.org/x';
    $('#save').click();
    await vi.waitFor(() => expect($('#status').textContent).toBe('Not a host name: not a host, foo..com'));
    expect($('#status').dataset.kind).toBe('error');
    expect(saves(sent)).toHaveLength(0);
  });

  it('omits jevEndpoint from the patch when the field is empty', async () => {
    const { sent } = await load();
    $('#jevEndpoint').value = '   ';
    $('#save').click();
    await vi.waitFor(() => expect(saves(sent)).toHaveLength(1));
    expect('jevEndpoint' in saves(sent)[0].patch).toBe(false);
  });

  it('Test shows the JSON result', async () => {
    await load({
      onMessage: (m) => (m.type === 'test-provider' ? { ok: true, aiProbability: 0.12, raw: { selected: 'human_written' } } : undefined)
    });
    $('#test').click();
    await vi.waitFor(() => expect($('#testResult').textContent).toContain('"aiProbability": 0.12'));
    expect($('#testResult').textContent).toContain('human_written');
  });

  it('shows an error reply from get-settings', async () => {
    await load({ onMessage: (m) => (m.type === 'get-settings' ? { error: 'forbidden' } : undefined) });
    expect($('#status').textContent).toMatch(/forbidden/);
  });
});
