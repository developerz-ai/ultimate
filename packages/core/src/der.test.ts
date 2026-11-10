// Known-answer vectors for the one DER walk: hand-assembled certificates whose SPKI is known byte
// for byte, the long-form lengths a real 2048-bit key needs, and every malformation answering
// `undefined`. Real certificates: `@ultimat3/auth`'s SAML vector, `@ultimat3/mail`'s SNS fixture.

import { describe, expect, test } from 'bun:test';
import { readDerTlv, x509Spki } from './der';

const hex = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(text.match(/[0-9a-f]{2}/g) ?? [], (b) => parseInt(b, 16));

/** A definite-length TLV, short or long form — the encoder the vectors below are pinned against. */
const tlv = (tag: number, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const body = Uint8Array.from(parts.flatMap((part) => [...part]));
  const n = body.byteLength;
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return Uint8Array.from([tag, ...length, ...body]);
};

const SPKI = '30 05 30 00 03 01 00';
// Certificate { tbs { [0]{v3} serial sigAlg issuer validity subject SPKI } sigAlg signature }
const V3 = hex(
  `30 1e 30 17 a0 03 02 01 02 02 01 07 30 00 30 00 30 00 30 00 ${SPKI} 30 00 03 01 00`,
);
// The same certificate with no `[0] version`: X.509 v1.
const V1 = hex(`30 19 30 12 02 01 07 30 00 30 00 30 00 30 00 ${SPKI} 30 00 03 01 00`);

describe('readDerTlv', () => {
  test('reads a short-form and a long-form length to the same offsets', () => {
    expect(readDerTlv(hex('30 03 02 01 05'), 0, 5)).toEqual({
      tag: 0x30,
      start: 0,
      body: 2,
      end: 5,
    });
    expect(readDerTlv(hex('04 81 02 aa bb'), 0, 5)).toEqual({
      tag: 0x04,
      start: 0,
      body: 3,
      end: 5,
    });
    expect(readDerTlv(hex('04 82 00 01 aa'), 0, 5)).toEqual({
      tag: 0x04,
      start: 0,
      body: 4,
      end: 5,
    });
  });

  test('refuses the indefinite form, five length octets and a length past the limit', () => {
    expect(readDerTlv(hex('30 80 00 00'), 0, 4)).toBeUndefined();
    expect(readDerTlv(hex('04 85 00 00 00 00 01 aa'), 0, 8)).toBeUndefined();
    expect(readDerTlv(hex('04 03 aa bb'), 0, 4)).toBeUndefined();
    expect(readDerTlv(hex('04 01 aa'), 0, 2)).toBeUndefined();
  });
});

describe('x509Spki', () => {
  test('the hand-assembled vectors are what the encoder builds', () => {
    const empty = tlv(0x30);
    const spki = tlv(0x30, empty, tlv(0x03, hex('00')));
    const fields = [tlv(0x02, hex('07')), empty, empty, empty, empty, spki];
    const sig = [empty, tlv(0x03, hex('00'))];
    expect(tlv(0x30, tlv(0x30, tlv(0xa0, tlv(0x02, hex('02'))), ...fields), ...sig)).toEqual(V3);
    expect(tlv(0x30, tlv(0x30, ...fields), ...sig)).toEqual(V1);
  });

  test('lifts the same SPKI out of a v3 and a v1 certificate', () => {
    expect(x509Spki(V3)).toEqual(hex(SPKI));
    expect(x509Spki(V1)).toEqual(hex(SPKI));
  });

  test('walks long-form lengths, as a 2048-bit key always has them', () => {
    const key = tlv(0x03, new Uint8Array(270).fill(0x5a));
    const spki = tlv(0x30, tlv(0x30, hex('06 01 2a')), key);
    const empty = tlv(0x30);
    const der = tlv(0x30, tlv(0x30, tlv(0x02, hex('01')), empty, empty, empty, empty, spki), empty);
    expect([der[1], spki[1]]).toEqual([0x82, 0x82]);
    expect(x509Spki(der)).toEqual(spki);
  });

  test('answers a copy whose buffer is its own, as importKey takes it', () => {
    const spki = x509Spki(V3);
    expect(spki?.buffer.byteLength).toBe(7);
  });

  test('every truncation, a trailing byte and a non-SEQUENCE are undefined, never a throw', () => {
    for (let length = 0; length < V3.byteLength; length += 1) {
      expect(x509Spki(V3.slice(0, length))).toBeUndefined();
    }
    expect(x509Spki(Uint8Array.from([...V3, 0]))).toBeUndefined();
    expect(x509Spki(Uint8Array.from([0x31, ...V3.slice(1)]))).toBeUndefined();
    // A tbsCertificate that ends before its seventh field holds no key.
    expect(x509Spki(hex('30 0b 30 09 02 01 07 30 00 30 00 30 00'))).toBeUndefined();
  });
});
