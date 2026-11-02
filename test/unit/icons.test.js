import { describe, it, expect } from 'vitest';
import { renderIcon, encodePng, ICON_SIZES } from '../../scripts/icons.mjs';

const px = (buf, size, x, y) => [...buf.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];

describe('icons', () => {
  it.each(ICON_SIZES)('renders %ipx: transparent corner, plum tile, white flag', (size) => {
    const buf = renderIcon(size);
    const at = (x, y) => px(buf, size, Math.floor((x / 128) * size), Math.floor((y / 128) * size));
    expect(at(0, 0)[3]).toBe(0);
    expect(at(64, 116)).toEqual([0x7d, 0x3f, 0x8a, 255]);
    expect(at(48, 40)).toEqual([255, 255, 255, 255]);
  });

  it('encodes an RGBA PNG with the right dimensions', () => {
    const png = encodePng(16, renderIcon(16));
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(16);
    expect(png[25]).toBe(6);
  });
});
