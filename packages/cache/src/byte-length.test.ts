// The byte count is a budget, so it must agree with what `TextEncoder` would have produced for
// every string — including the lone surrogates `TextEncoder` replaces with U+FFFD — without
// producing it. Seeded, so a failure names a string that reproduces.

import { describe, expect, test } from 'bun:test';
import { utf8ByteLength } from './byte-length';

const encoder = new TextEncoder();

/** mulberry32: a deterministic stream, so a red run prints a seed that fails again. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One code unit sequence from each class the count branches on. */
function piece(next: () => number): string {
  const pick = Math.floor(next() * 6);
  const span = (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1));
  switch (pick) {
    case 0:
      return String.fromCharCode(span(0x00, 0x7f)); // ASCII: 1
    case 1:
      return String.fromCharCode(span(0x80, 0x7ff)); // 2
    case 2:
      return String.fromCharCode(span(0xe000, 0xffff)); // BMP above the surrogates: 3
    case 3:
      return String.fromCodePoint(span(0x10000, 0x10ffff)); // astral pair: 4
    case 4:
      return String.fromCharCode(span(0xd800, 0xdbff)); // lone high surrogate: 3 (U+FFFD)
    default:
      return String.fromCharCode(span(0xdc00, 0xdfff)); // lone low surrogate: 3 (U+FFFD)
  }
}

describe('utf8ByteLength', () => {
  test('agrees with TextEncoder on 2000 seeded strings of every code unit class', () => {
    for (let seed = 1; seed <= 2000; seed += 1) {
      const next = rng(seed);
      const length = Math.floor(next() * 24);
      let text = '';
      for (let i = 0; i < length; i += 1) text += piece(next);
      const expected = encoder.encode(text).byteLength;
      if (utf8ByteLength(text) !== expected) {
        expect({ seed, text, bytes: utf8ByteLength(text) }).toEqual({
          seed,
          text,
          bytes: expected,
        });
      }
    }
  });

  test('the boundaries of each class', () => {
    const cases = [
      '',
      'abc',
      '\u007f',
      '\u0080',
      '߿',
      'ࠀ',
      '￿',
      '😀',
      '\ud800',
      '\udfff',
      '\udc00\ud800', // low then high: two lone surrogates, not a pair
      'a\ud800',
      '\ud800a',
    ];
    for (const text of cases) {
      expect([text, utf8ByteLength(text)]).toEqual([text, encoder.encode(text).byteLength]);
    }
  });
});
