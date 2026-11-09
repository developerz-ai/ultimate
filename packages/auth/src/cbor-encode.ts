// Single responsibility: the CBOR ENCODER for the subset `cbor.ts` decodes — what the software
// authenticator writes an attestation object and a COSE key with. Shortest-form heads, definite
// lengths, keys in the order given: canonical enough for every map an authenticator sends.

import type { CborValue } from './cbor';

const head = (major: number, value: number): number[] => {
  if (value < 24) return [(major << 5) | value];
  if (value < 0x100) return [(major << 5) | 24, value];
  if (value < 0x10000) return [(major << 5) | 25, value >> 8, value & 0xff];
  if (value >= 2 ** 32) {
    const bytes: number[] = [];
    for (let rest = value, index = 0; index < 8; index += 1, rest = Math.floor(rest / 256)) {
      bytes.unshift(rest % 256);
    }
    return [(major << 5) | 27, ...bytes];
  }
  return [
    (major << 5) | 26,
    (value >>> 24) & 0xff,
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
  ];
};

/** One CBOR item, for the subset `cbor.ts` reads. */
export function cborEncode(value: CborValue): Uint8Array {
  const out: number[] = [];
  const walk = (item: CborValue): void => {
    if (typeof item === 'number') out.push(...(item >= 0 ? head(0, item) : head(1, -1 - item)));
    else if (typeof item === 'string') {
      const bytes = new TextEncoder().encode(item);
      out.push(...head(3, bytes.length), ...bytes);
    } else if (item instanceof Uint8Array) out.push(...head(2, item.length), ...item);
    else if (item === false) out.push(0xf4);
    else if (item === true) out.push(0xf5);
    else if (item === null) out.push(0xf6);
    else if (item instanceof Map) {
      out.push(...head(5, item.size));
      for (const [key, entry] of item) {
        walk(key);
        walk(entry);
      }
    } else if (Array.isArray(item)) {
      out.push(...head(4, item.length));
      for (const entry of item) walk(entry);
    }
  };
  walk(value);
  return Uint8Array.from(out);
}
