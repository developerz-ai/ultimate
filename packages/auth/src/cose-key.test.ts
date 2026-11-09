// The COSE key importer and the DER signature reader: a real P-256 / RSA key imports, every
// malformed or unsupported key answers `null`, and only strict DER reaches WebCrypto.

import { describe, expect, test } from 'bun:test';
import type { CborValue } from './cbor';
import { cborEncode } from './cbor-encode';
import { COSE_ES256, ecdsaDerToRaw, importCoseKey } from './cose-key';
import { ecdsaRawToDer } from './soft-authenticator';

const p256 = async (): Promise<Map<number, CborValue>> => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return new Map<number, CborValue>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, raw.slice(1, 33)],
    [-3, raw.slice(33)],
  ]);
};

describe('importCoseKey', () => {
  test('a P-256 ES256 key imports with the algorithm the KEY names', async () => {
    expect((await importCoseKey(cborEncode(await p256())))?.algorithm).toBe(COSE_ES256);
  });

  test.each([
    ['another curve', (key: Map<number, CborValue>) => key.set(-1, 2)],
    ['an algorithm this package does not verify', (key: Map<number, CborValue>) => key.set(3, -8)],
    ['a short x coordinate', (key: Map<number, CborValue>) => key.set(-2, new Uint8Array(31))],
    [
      'a point off the curve',
      (key: Map<number, CborValue>) => key.set(-3, new Uint8Array(32).fill(7)),
    ],
    ['an OKP key type', (key: Map<number, CborValue>) => key.set(1, 1)],
  ])('%s is no key', async (_name, edit) => {
    const key = await p256();
    edit(key);
    expect(await importCoseKey(cborEncode(key))).toBeNull();
  });

  test('an RSA modulus under 2048 bits is no key', async () => {
    const short = new Map<number, CborValue>([
      [1, 3],
      [3, -257],
      [-1, new Uint8Array(128).fill(0xc1)],
      [-2, Uint8Array.of(1, 0, 1)],
    ]);
    expect(await importCoseKey(cborEncode(short))).toBeNull();
  });

  test('bytes that are not one CBOR map are no key', async () => {
    expect(await importCoseKey(Uint8Array.of(0x01))).toBeNull();
  });
});

describe('ecdsaDerToRaw', () => {
  const raw = Uint8Array.from({ length: 64 }, (_, index) => (index * 37 + 129) & 0xff);

  test('strict DER round-trips to the raw r || s', () => {
    expect(ecdsaDerToRaw(ecdsaRawToDer(raw))).toEqual(raw);
  });

  test('a small r keeps its left padding', () => {
    const small = new Uint8Array(64);
    small[31] = 5;
    small[63] = 9;
    expect(ecdsaDerToRaw(ecdsaRawToDer(small))).toEqual(small);
  });

  test.each([
    ['a trailing byte', (der: Uint8Array) => Uint8Array.from([...der, 0])],
    [
      'a wrong outer length',
      (der: Uint8Array) => Uint8Array.from([0x30, (der[1] ?? 0) + 1, ...der.slice(2)]),
    ],
    ['raw bytes, not DER', () => raw],
    ['an empty buffer', () => new Uint8Array()],
  ])('%s is refused', (_name, edit) => {
    expect(ecdsaDerToRaw(edit(ecdsaRawToDer(raw)))).toBeNull();
  });

  test('a non-minimal leading zero is refused', () => {
    const r = [0x00, 0x01, ...new Uint8Array(31)];
    const s = [0x01];
    const der = Uint8Array.from([
      0x30,
      4 + r.length + s.length,
      0x02,
      r.length,
      ...r,
      0x02,
      s.length,
      ...s,
    ]);
    expect(ecdsaDerToRaw(der)).toBeNull();
  });
});
