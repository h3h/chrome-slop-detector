import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
// Build into a fresh temp dir so the test never touches dist/ (e2e runs may be using it).
const DIST = join(mkdtempSync(join(tmpdir(), 'slop-flag-build-')), 'out');

describe('build', () => {
  let manifest;
  beforeAll(() => {
    execFileSync(process.execPath, ['scripts/build.mjs', '--out', DIST], { cwd: ROOT, stdio: 'pipe' });
    manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
  }, 60000);
  afterAll(() => rmSync(dirname(DIST), { recursive: true, force: true }));

  it('emits a MV3 manifest', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toEqual({ service_worker: 'background/sw.js', type: 'module' });
  });

  it('every file the manifest references exists', () => {
    const refs = [
      manifest.background.service_worker,
      manifest.action.default_popup,
      manifest.options_page,
      ...Object.values(manifest.icons),
      ...Object.values(manifest.action.default_icon),
      ...manifest.content_scripts.flatMap((c) => c.js)
    ];
    expect(refs.length).toBeGreaterThan(6);
    for (const r of refs) expect(existsSync(join(DIST, r)), r).toBe(true);
  });

  it('pages reference built scripts and styles that exist', () => {
    for (const page of ['popup/index.html', 'options/index.html']) {
      const html = readFileSync(join(DIST, page), 'utf8');
      const dir = page.split('/')[0];
      const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
      expect(refs.length).toBeGreaterThan(1);
      for (const r of refs) expect(existsSync(join(DIST, dir, r)), `${page} -> ${r}`).toBe(true);
    }
  });

  it('runs yt-main in the MAIN world at document_start', () => {
    const yt = manifest.content_scripts.find((c) => c.js.includes('content/yt-main.js'));
    expect(yt).toMatchObject({ world: 'MAIN', run_at: 'document_start', matches: ['https://www.youtube.com/*'] });
  });

  it('content scripts are self-contained bundles (no top-level imports)', () => {
    for (const f of ['content/main.js', 'content/yt-main.js']) {
      const src = readFileSync(join(DIST, f), 'utf8');
      expect(src, f).not.toMatch(/^\s*import[\s{*"']/m);
      expect(src, f).not.toMatch(/^\s*export\s/m);
    }
  });

  it('refuses unsafe output dirs without deleting anything', async () => {
    const { checkOutDir } = await import('../../scripts/build.mjs');
    const scratch = mkdtempSync(join(tmpdir(), 'slop-flag-guard-'));
    try {
      writeFileSync(join(scratch, 'keep.txt'), 'x');
      expect(() => checkOutDir(scratch)).toThrow(/non-empty/);
      expect(() => checkOutDir(join(scratch, 'keep.txt'))).toThrow(/not a directory/);
      expect(() => checkOutDir(join(ROOT, 'src'))).toThrow(/only dist/);
      expect(() => checkOutDir(join(ROOT, 'src', 'out'))).toThrow(/only dist/);
      expect(() => checkOutDir(ROOT)).toThrow(/only dist/);
      expect(() => checkOutDir(join(ROOT, 'build'))).toThrow(/only dist/);
      expect(() => checkOutDir(dirname(ROOT))).toThrow(/contains the project/);
      expect(() => checkOutDir('/')).toThrow(/contains the project/);
      // Allowed: dist/, a fresh dir, an empty dir, a previous build.
      expect(checkOutDir(join(ROOT, 'dist'))).toBe(join(ROOT, 'dist'));
      expect(() => checkOutDir(join(scratch, 'new'))).not.toThrow();
      mkdirSync(join(scratch, 'empty'));
      expect(() => checkOutDir(join(scratch, 'empty'))).not.toThrow();
      expect(() => checkOutDir(DIST)).not.toThrow();
      // The CLI refuses too and leaves the dir alone.
      expect(() => execFileSync(process.execPath, ['scripts/build.mjs', '--out', scratch], { cwd: ROOT, stdio: 'pipe' })).toThrow(/Refusing/);
      expect(readdirSync(scratch)).toContain('keep.txt');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('icons are PNG files', () => {
    for (const size of [16, 48, 128]) {
      const buf = readFileSync(join(DIST, `icons/icon${size}.png`));
      expect(buf.subarray(1, 4).toString('latin1')).toBe('PNG');
      expect(buf.readUInt32BE(16)).toBe(size);
    }
  });
});
