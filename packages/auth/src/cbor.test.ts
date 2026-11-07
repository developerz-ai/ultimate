// The CBOR subset decoder on hostile bytes: every shape WebAuthn sends round-trips, and every
// shape it does not — tags, floats, indefinite lengths, truncation, duplicate keys, deep nesting,
// invalid UTF-8, trailing bytes — answers no value rather than a guess or a throw.

import { describe, expect, test } from 'bun:test';
import { type CborValue, decodeCbor, decodeCborItem } from './cbor';
import { cborEncode } from './cbor-encode';

describe('decodeCbor', () => {
  test('the shapes an attestation object and a COSE key carry round-trip', () => {
    const value = new Map<number | string, CborValue>([
      [1, 2],
      [-1, 1],
      [3, -257],
      ['fmt', 'none'],
      ['authData', Uint8Array.of(1, 2, 3)],
      ['list', [true, false, null, 70_000, 2 ** 32 + 5]],
    ]);
    expect(decodeCbor(cborEncode(value))).toEqual(value);
  });

  test.each([
    ['a tag', [0xc0, 0x00]],
    ['a float', [0xfa, 0x00, 0x00, 0x00, 0x00]],
    ['an indefinite-length byte string', [0x5f, 0x41, 0x00, 0xff]],
    ['a truncated byte string', [0x45, 0x01, 0x02]],
    ['a truncated length', [0x19, 0x01]],
    ['a reserved additional info', [0x1c]],
    ['a duplicate map key', [0xa2, 0x01, 0x00, 0x01, 0x00]],
    ['a non-scalar map key', [0xa1, 0x80, 0x00]],
    ['invalid UTF-8 text', [0x62, 0xc3, 0x28]],
    ['trailing bytes', [0x00, 0x00]],
    ['an empty buffer', []],
    ['an undefined simple value', [0xf7]],
  ])('%s is no value', (_name, bytes) => {
    expect(decodeCbor(Uint8Array.from(bytes))).toBeUndefined();
  });

  test('nesting past the depth bound is refused, not recursed into', () => {
    expect(decodeCbor(Uint8Array.from([...Array(20).fill(0x81), 0x00]))).toBeUndefined();
  });

  test('an array claiming more items than the bound is refused before any allocation', () => {
    expect(decodeCbor(Uint8Array.from([0x9a, 0xff, 0xff, 0xff, 0xff]))).toBeUndefined();
  });

  test('decodeCborItem reports where the item ended, for the bytes after a COSE key', () => {
    expect(decodeCborItem(Uint8Array.from([0x01, 0xff]))).toEqual({ value: 1, end: 1 });
  });
});
