// The claim `qr-encode.test.ts` cannot make: what `encodeQr` draws READS. An independent reader
// (`qr-reader.ts`, sharing no code with the encoder) must recover the exact text, on a symbol
// with no layout fault, at every version and every mask the encoder may pick.

import { describe, expect, test } from 'bun:test';
import { encodeQr } from './qr-matrix';
import { readQr } from './qr-reader';

const VECTORS: readonly (readonly [string, number])[] = [
  ['A', 1],
  ['hello world', 1],
  ['a'.repeat(14), 1],
  ['https://dev.ai/abcd1', 2],
  ['héllo wörld €', 2],
  ['a'.repeat(26), 2],
  ['https://developerz.ai/a1b2c3', 3],
  [`https://developerz.ai/${'x'.repeat(20)}`, 3],
  ['a'.repeat(42), 3],
];

describe('encodeQr output read back by an independent reader', () => {
  for (const [text, version] of VECTORS) {
    test(`${JSON.stringify(text)} reads back at version ${version}`, () => {
      const matrix = encodeQr(text);
      expect(matrix.version).toBe(version);
      const reading = readQr(matrix.modules);
      expect(reading.layoutFaults).toEqual([]);
      expect(reading.text).toBe(text);
    });
  }

  test('the masks chosen across the vectors are not all one pattern', () => {
    const masks = new Set(VECTORS.map(([text]) => readQr(encodeQr(text).modules).mask));
    expect(masks.size).toBeGreaterThan(1);
  });
});
