// Renders the extension icons. Usage: node scripts/icons.mjs (rewrites src/icons/*.png).
// Dependency-free: shapes are flattened to polygons on a 128-unit grid, supersampled, and
// written as RGBA PNG. See docs/2026-11-01-visual-identity-design.md.
import { writeFile, mkdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ICON_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'src', 'icons');
export const ICON_SIZES = [16, 32, 48, 128];
const PLUM = [0x7d, 0x3f, 0x8a];
const WHITE = [0xff, 0xff, 0xff];

// --- geometry (128x128 design grid) ---
function roundRect(x, y, w, h, r) {
  const pts = [];
  const corners = [
    [x + w - r, y + r, -90],
    [x + w - r, y + h - r, 0],
    [x + r, y + h - r, 90],
    [x + r, y + r, 180]
  ];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= 8; i++) {
      const a = ((start + (i * 90) / 8) * Math.PI) / 180;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return pts;
}

// Path from a start point and segments: [x, y] line, [c1x, c1y, x, y] quadratic,
// [c1x, c1y, c2x, c2y, x, y] cubic.
function path(start, segs) {
  const pts = [start];
  for (const s of segs) {
    const [px, py] = pts[pts.length - 1];
    if (s.length === 2) {
      pts.push(s);
      continue;
    }
    for (let i = 1; i <= 12; i++) {
      const t = i / 12;
      const u = 1 - t;
      if (s.length === 4) {
        pts.push([u * u * px + 2 * u * t * s[0] + t * t * s[2], u * u * py + 2 * u * t * s[1] + t * t * s[3]]);
      } else {
        const b = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
        pts.push([b[0] * px + b[1] * s[0] + b[2] * s[2] + b[3] * s[4], b[0] * py + b[1] * s[1] + b[2] * s[3] + b[3] * s[5]]);
      }
    }
  }
  return pts;
}

function sparkle(cx, cy, rx, ry) {
  return path([cx, cy - ry], [
    [cx + rx * 0.18, cy - ry * 0.18, cx + rx, cy],
    [cx + rx * 0.18, cy + ry * 0.18, cx, cy + ry],
    [cx - rx * 0.18, cy + ry * 0.18, cx - rx, cy],
    [cx - rx * 0.18, cy - ry * 0.18, cx, cy - ry]
  ]);
}

// Painted in order; the sparkle is "cut" by painting the tile colour over the flag.
// At 16px a cut that small blurs to grey, so the toolbar size gets a bolder sparkle.
export function shapes(size) {
  const big = size >= 32;
  return [
    [PLUM, roundRect(0, 0, 128, 128, 28)],
    [WHITE, roundRect(26, 18, big ? 11 : 14, 92, 5)],
    [WHITE, path([big ? 37 : 40, 22], [[56, 12, 74, 34, 108, 22], [108, 74], [74, 86, 56, 64, big ? 37 : 40, 74], [big ? 37 : 40, 22]])],
    [PLUM, big ? sparkle(72, 47, 14, 18) : sparkle(74, 47, 18, 21)]
  ];
}

function inside(pts, x, y) {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

// RGBA pixels, row-major, 4 bytes per pixel.
export function renderIcon(size, ss = 4) {
  const layers = shapes(size);
  const out = Buffer.alloc(size * size * 4);
  const k = 128 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) * k;
          const y = (py + (sy + 0.5) / ss) * k;
          let col = null;
          for (const [c, pts] of layers) if (inside(pts, x, y)) col = c;
          if (!col) continue;
          r += col[0];
          g += col[1];
          b += col[2];
          a++;
        }
      }
      const o = (py * size + px) * 4;
      // Colour is averaged over covered samples only, so edges don't darken.
      if (a) out.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round((255 * a) / (ss * ss))], o);
    }
  }
  return out;
}

// --- minimal PNG encoder (RGBA, 8-bit) ---
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

export function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size); // each row: filter byte 0, then pixels
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

export const iconPath = (size) => join(ICON_DIR, `icon${size}.png`);

export async function writeIcon(size) {
  await mkdir(ICON_DIR, { recursive: true });
  await writeFile(iconPath(size), encodePng(size, renderIcon(size)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const size of ICON_SIZES) await writeIcon(size);
}
