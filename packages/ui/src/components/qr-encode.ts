// The data half of a pure-TypeScript QR encoder — byte mode, error-correction level M, no
// dependency: the framework's own docs use a sparkline pulling in a charting library as the
// cautionary example (see `BarChart.tsx`), and a QR library would be the same mistake for a
// component that draws one short URL. `qr-matrix.ts` is the placement half.
//
// SUPPORTED VERSION RANGE: 1 through 3 ONLY (21x21 through 29x29 modules), byte mode, EC level M.
// That is not a shortcut that happens to work for `HELLO WORLD` and nothing else: version 3's
// byte-mode capacity at level M is 42 bytes, and a short URL (`origin + '/' + 6-char slug`) runs
// roughly 25-30 bytes — comfortably inside version 3, and past version 1's 14-byte and version 2's
// 26-byte ceilings for anything but the shortest local origin. Encoding a longer payload (a longer
// domain, a full page URL) throws `X_UI_QR_CAPACITY` naming the byte count and the version-3
// ceiling, rather than silently truncating a link nobody could then scan.
//
// Versions 1-3 are the ones with AT MOST ONE alignment pattern (version 1 has none) and no
// version-information block (that only starts at version 7) — the two things that make the
// placement algorithm tractable without the full 1-40 table set a general-purpose encoder needs.
// Versions 1-3 at level M also always split into exactly ONE Reed-Solomon block, so no
// interleaving is needed either.

import { qrCapacityError } from '../errors';

/** The one error correction level this module implements — the format-info field for level M. */
export const EC_LEVEL_M_INDICATOR = 0b00;

/** The largest version this encoder draws. */
export const MAX_VERSION = 3;

/** Per-version constants, indexed by `version - 1`. Hardcoded because only versions 1-3 exist
 *  here — a general encoder would read these from the ISO 18004 tables for all 40 versions. */
const TOTAL_CODEWORDS: readonly number[] = [26, 44, 70];
const ECC_CODEWORDS_PER_BLOCK: readonly number[] = [10, 16, 26];

/** Alignment pattern center coordinates along one axis; the full set of centers is every pair
 *  from this list, MINUS the corner that overlaps the top-left finder pattern. Version 1 has no
 *  alignment pattern at all. */
export const ALIGNMENT_POSITIONS: readonly (readonly number[])[] = [[], [6, 18], [6, 22]];

const MODE_BYTE = 0b0100;
/** Versions 1-9 use an 8-bit character-count field for byte mode. */
const CHAR_COUNT_BITS = 8;

/** Data codewords at `version`: the total minus the error-correction block. */
export function dataCapacityBytes(version: number): number {
  return (TOTAL_CODEWORDS[version - 1] ?? 0) - (ECC_CODEWORDS_PER_BLOCK[version - 1] ?? 0);
}

/** Mode indicator (4 bits) + character count (8 bits) precede the payload in the data stream. */
const HEADER_BITS = 4 + CHAR_COUNT_BITS;

/** The most payload bytes `version` holds: the data codewords minus the header's 12 bits, which
 *  cost two whole bytes once the stream is byte-aligned — 14, 26 and 42 for versions 1-3. NOT
 *  `dataCapacityBytes`: that is 44 at version 3, and an error naming 44 as the ceiling would
 *  tell the reader a 43-byte value fits when it does not. */
export function payloadCapacityBytes(version: number): number {
  return Math.floor((dataCapacityBytes(version) * 8 - HEADER_BITS) / 8);
}

/** The smallest of versions 1-3 whose data capacity holds `byteLength` bytes of byte-mode
 *  payload, accounting for the header's own 12 bits (1.5 bytes) and a 4-bit terminator that can
 *  share the last byte. Throws past version 3's ceiling. */
export function pickVersion(byteLength: number): number {
  for (let version = 1; version <= MAX_VERSION; version++) {
    if (byteLength <= payloadCapacityBytes(version)) return version;
  }
  throw qrCapacityError(byteLength, payloadCapacityBytes(MAX_VERSION));
}

/** Modules per side: 21, 25, 29 for versions 1, 2, 3. */
export function sizeForVersion(version: number): number {
  return 4 * version + 17;
}

// ---------------------------------------------------------------------------------------------
// GF(256) arithmetic and Reed-Solomon error correction (ISO 18004 Annex A).
// ---------------------------------------------------------------------------------------------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(function initGaloisField(): void {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if ((x & 0x100) !== 0) x ^= 0x11d; // primitive polynomial x^8 + x^4 + x^3 + x^2 + 1
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255] ?? 0;
})();

export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] ?? 0) + (GF_LOG[b] ?? 0)] ?? 0;
}

/** The generator polynomial for a Reed-Solomon code with `degree` correction codewords, as the
 *  coefficients of (x - 2^0)(x - 2^1)...(x - 2^(degree-1)), highest degree first, monic term
 *  implicit. */
export function rsGeneratorPolynomial(degree: number): Uint8Array {
  const coefs = new Uint8Array(degree);
  coefs[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      coefs[j] = gfMul(coefs[j] ?? 0, root);
      if (j + 1 < degree) coefs[j] = (coefs[j] ?? 0) ^ (coefs[j + 1] ?? 0);
    }
    root = gfMul(root, 2);
  }
  return coefs;
}

/** The Reed-Solomon remainder (the error-correction codewords) of `data` divided by the
 *  generator polynomial `divisor` — polynomial long division carried out in GF(256). */
export function rsRemainder(data: readonly number[], divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ (result[0] ?? 0);
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) {
      result[i] = (result[i] ?? 0) ^ gfMul(divisor[i] ?? 0, factor);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Data encoding: byte mode, terminator, padding, error correction.
// ---------------------------------------------------------------------------------------------

/** A growable bit buffer, most-significant-bit first — the order every field in a QR symbol's
 *  data stream is written in. */
export class BitBuffer {
  private bits: number[] = [];

  appendBits(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }

  /** Pads to a whole byte with zero bits, then returns one byte per 8 bits. */
  toBytes(): number[] {
    while (this.bits.length % 8 !== 0) this.bits.push(0);
    const bytes: number[] = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (this.bits[i + j] ?? 0);
      bytes.push(byte);
    }
    return bytes;
  }
}

/** The pad codewords the standard alternates until the block is full. */
const PAD = [0xec, 0x11] as const;

/** The full codeword sequence for one QR symbol at `version`: data codewords (byte-mode payload,
 *  terminated and padded to capacity) followed by the Reed-Solomon error-correction codewords.
 *  Versions 1-3 at level M are always exactly one block, so no interleaving is needed. */
export function buildCodewords(payload: Uint8Array, version: number): number[] {
  const capacity = dataCapacityBytes(version);
  const buffer = new BitBuffer();
  buffer.appendBits(MODE_BYTE, 4);
  buffer.appendBits(payload.length, CHAR_COUNT_BITS);
  for (const byte of payload) buffer.appendBits(byte, 8);

  // Terminator: up to 4 zero bits, but never past the data capacity — a payload that exactly
  // fills the capacity gets no terminator at all, per the standard.
  const terminatorBits = Math.min(4, capacity * 8 - buffer.length);
  if (terminatorBits > 0) buffer.appendBits(0, terminatorBits);

  const dataBytes = buffer.toBytes();
  // Pad codewords 0xEC, 0x11 alternating until the block is exactly `capacity` bytes.
  let padIndex = 0;
  while (dataBytes.length < capacity) {
    dataBytes.push(PAD[padIndex % 2] ?? 0);
    padIndex++;
  }

  const eccLength = ECC_CODEWORDS_PER_BLOCK[version - 1] ?? 0;
  const ecc = rsRemainder(dataBytes, rsGeneratorPolynomial(eccLength));
  return [...dataBytes, ...Array.from(ecc)];
}
