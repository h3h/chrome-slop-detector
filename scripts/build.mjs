// Builds the unpacked extension. Usage: node scripts/build.mjs [--out <dir>]
// Output dir: --out argument, else SLOP_OUT env, else dist/ (relative paths resolve from cwd).
import { build } from 'esbuild';
import { rm, mkdir, cp, readFile, access } from 'node:fs/promises';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICON_SIZES, iconPath, writeIcon } from './icons.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

export function outDir(argv = process.argv.slice(2), env = process.env) {
  const i = argv.indexOf('--out');
  if (i !== -1) {
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) throw new Error('--out needs a directory');
    return resolve(v);
  }
  return env.SLOP_OUT ? resolve(env.SLOP_OUT) : join(ROOT, 'dist');
}

const ENTRIES = [
  ['content/main.js', 'iife'],
  ['content/yt-main.js', 'iife'],
  ['background/sw.js', 'esm'],
  ['popup/popup.js', 'esm'],
  ['options/options.js', 'esm']
];
const STATIC = ['manifest.json', 'popup/index.html', 'popup/popup.css', 'options/index.html', 'options/options.css'];

// true if `child` is `parent` or inside it.
function within(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// The output dir is deleted before building, so only allow ROOT/dist or a dir outside the
// project (that does not contain it), and never an existing non-empty dir that doesn't
// look like a previous build. Throws; deletes nothing.
export function checkOutDir(dir) {
  const d = resolve(dir);
  const refuse = (why) => {
    throw new Error(`Refusing to build into ${d}: ${why}`);
  };
  if (d !== join(ROOT, 'dist')) {
    if (within(ROOT, d)) refuse('only dist/ is allowed inside the project');
    if (within(d, ROOT)) refuse('it contains the project');
  }
  if (existsSync(d)) {
    if (!statSync(d).isDirectory()) refuse('not a directory');
    if (readdirSync(d).length && !existsSync(join(d, 'manifest.json'))) refuse('non-empty and not a previous build');
  }
  return d;
}

const exists = (p) => access(p).then(() => true, () => false);

// Icons are committed; this only regenerates them if they were deleted.
async function ensureIcons() {
  for (const size of ICON_SIZES) if (!(await exists(iconPath(size)))) await writeIcon(size);
}

async function main() {
  const DIST = outDir();
  checkOutDir(DIST);
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await ensureIcons();
  await Promise.all(
    ENTRIES.map(([entry, format]) =>
      build({
        entryPoints: [join(SRC, entry)],
        outfile: join(DIST, entry),
        bundle: true,
        format,
        target: 'chrome111',
        platform: 'browser',
        legalComments: 'none',
        logLevel: 'warning'
      })
    )
  );
  for (const f of STATIC) {
    await mkdir(dirname(join(DIST, f)), { recursive: true });
    await cp(join(SRC, f), join(DIST, f));
  }
  await cp(join(SRC, 'icons'), join(DIST, 'icons'), { recursive: true });
  // Fail loudly if the copied manifest is not valid JSON.
  JSON.parse(await readFile(join(DIST, 'manifest.json'), 'utf8'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
