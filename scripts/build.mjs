// Builds the unpacked extension. Usage: node scripts/build.mjs [--out <dir>]
// Output dir: --out argument, else SLOP_OUT env, else dist/ (relative paths resolve from cwd).
import { build } from 'esbuild';
import { rm, mkdir, cp, readFile, writeFile, access } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const ICON_SIZES = [16, 48, 128];
const ICON_RGB = [0xc6, 0x28, 0x28];

const ENTRIES = [
  ['content/main.js', 'iife'],
  ['content/yt-main.js', 'iife'],
  ['background/sw.js', 'esm'],
  ['popup/popup.js', 'esm'],
  ['options/options.js', 'esm']
];
const STATIC = ['manifest.json', 'popup/index.html', 'popup/popup.css', 'options/index.html', 'options/options.css'];

// --- minimal PNG encoder (solid colour, RGB, 8-bit) ---
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function solidPng(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const row = Buffer.alloc(1 + size * 3); // filter byte 0, then pixels
  for (let x = 0; x < size; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

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
  await mkdir(join(SRC, 'icons'), { recursive: true });
  for (const size of ICON_SIZES) {
    const p = join(SRC, 'icons', `icon${size}.png`);
    if (!(await exists(p))) await writeFile(p, solidPng(size, ICON_RGB));
  }
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
