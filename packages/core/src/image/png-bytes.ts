// Single responsibility: PNG's byte-level primitives — signature, chunk framing, the two
// checksums and the Paeth predictor. Both directions of the codec need every one of them, so
// they live here once: a CRC that agreed with itself but not with libpng would be invisible
// if the reader and the writer each carried their own copy.

const NO_BYTES = new Uint8Array(0);

export const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

export const EMPTY_CHUNK_DATA: Uint8Array = NO_BYTES;

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

export function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) {
    c = (CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** RFC 1950 checksum. 5552 is the most sums that fit before the accumulators overflow. */
export function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  let i = 0;
  while (i < bytes.length) {
    const end = Math.min(i + 5552, bytes.length);
    for (; i < end; i += 1) {
      a += bytes[i] ?? 0;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

export const readU32 = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) * 0x1000000 +
  (((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0));

export function writeU32(out: Uint8Array, at: number, value: number): void {
  out[at] = (value >>> 24) & 0xff;
  out[at + 1] = (value >>> 16) & 0xff;
  out[at + 2] = (value >>> 8) & 0xff;
  out[at + 3] = value & 0xff;
}

export function joinBytes(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0] ?? NO_BYTES;
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** One framed chunk: length, type, data, CRC-32 over type and data. */
export function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  writeU32(out, 0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  writeU32(out, data.length + 8, crc32(out, 4, data.length + 8));
  return out;
}

/** Bun's zlib refuses a view onto a SharedArrayBuffer, and decoder input can be backed by one. */
export const unshared = (view: Uint8Array): Uint8Array<ArrayBuffer> =>
  view.buffer instanceof ArrayBuffer
    ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    : Uint8Array.from(view);

/** The filter both directions predict with: the decoder adds it back, the encoder subtracts it. */
export function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
