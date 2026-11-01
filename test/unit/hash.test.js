import { it, expect } from 'vitest';
import { sha256Hex } from '../../src/lib/hash.js';
it('hashes utf8', async () => {
  expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
