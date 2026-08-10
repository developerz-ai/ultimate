// Single responsibility: JPEG's entropy layer — the canonical Huffman decode table derived from a
// DHT segment's bits/values, and the MSB-first bit reader that unstuffs `FF 00` and refuses to read
// through a marker. Split out of the decoder because it knows nothing of blocks, colour or frames.

import { imageDecodeFailed } from './errors';

/**
 * T.81 Annex F's `MINCODE`/`MAXCODE`/`VALPTR` form rather than a code tree: three flat arrays
 * indexed by code length decode a symbol in one comparison per bit, with no pointer chasing and
 * no allocation per block. `maxcode[l]` is -1 when the table has no code of length `l`.
 */
export interface HuffmanTable {
  readonly mincode: Int32Array;
  readonly maxcode: Int32Array;
  readonly valptr: Int32Array;
  readonly values: Uint8Array;
}

/** `bits[i]` counts the codes of length `i + 1`; `values` lists the symbols in code order. */
export function buildHuffmanTable(bits: Uint8Array, values: Uint8Array): HuffmanTable {
  const mincode = new Int32Array(17);
  const maxcode = new Int32Array(17).fill(-1);
  const valptr = new Int32Array(17);
  let code = 0;
  let assigned = 0;
  for (let length = 1; length <= 16; length += 1) {
    const count = bits[length - 1] ?? 0;
    if (count > 0) {
      valptr[length] = assigned;
      mincode[length] = code;
      assigned += count;
      code += count;
      maxcode[length] = code - 1;
    }
    // More codes than the length can hold means the table is over-subscribed: some code would
    // be a prefix of another and the scan would decode into a different image than it encodes.
    if (code > 1 << length) {
      throw imageDecodeFailed(
        `a DHT table is over-subscribed at code length ${length}: it needs more codes than ` +
          `${1 << length} distinct ones`,
        { length, codes: code },
      );
    }
    code <<= 1;
  }
  if (assigned !== values.length) {
    throw imageDecodeFailed(
      `a DHT table declares ${assigned} codes but carries ${values.length} symbols`,
      { codes: assigned, symbols: values.length },
    );
  }
  return { mincode, maxcode, valptr, values };
}

/** A DHT segment packs several tables, each a class/id byte then 16 counts then the symbols. */
export function readHuffmanTables(
  seg: Uint8Array,
  dc: Array<HuffmanTable | undefined>,
  ac: Array<HuffmanTable | undefined>,
): void {
  let at = 0;
  while (at < seg.length) {
    const spec = seg[at] ?? 0;
    at += 1;
    const kind = spec >> 4;
    const id = spec & 15;
    if (kind > 1 || id > 3) {
      throw imageDecodeFailed(`DHT declares class ${kind} table ${id}, outside class 0-1 id 0-3`, {
        kind,
        id,
      });
    }
    if (at + 16 > seg.length) {
      throw imageDecodeFailed(`DHT table ${id} is truncated before its 16 code-length counts`, {
        id,
      });
    }
    const bits = seg.subarray(at, at + 16);
    at += 16;
    let total = 0;
    for (let i = 0; i < 16; i += 1) total += bits[i] ?? 0;
    if (at + total > seg.length) {
      throw imageDecodeFailed(
        `DHT table ${id} declares ${total} symbols but the segment holds ${seg.length - at}`,
        { id, symbols: total },
      );
    }
    (kind === 0 ? dc : ac)[id] = buildHuffmanTable(bits, seg.subarray(at, at + total));
    at += total;
  }
}

/**
 * Walks entropy-coded data one bit at a time, most significant first. Every failure is a coded
 * error rather than a zero bit, because padding a truncated scan with zeros yields a plausible
 * grey image and no signal that anything went wrong.
 */
export class JpegBitReader {
  private readonly bytes: Uint8Array;
  private at: number;
  private buffer = 0;
  private count = 0;

  constructor(bytes: Uint8Array, start: number) {
    this.bytes = bytes;
    this.at = start;
  }

  /** Where the next unread byte begins — the marker walk resumes the file from here. */
  get position(): number {
    return this.at;
  }

  private nextByte(): number {
    if (this.at >= this.bytes.length) {
      throw imageDecodeFailed('the entropy-coded data ends before the scan does (truncated JPEG)', {
        at: this.at,
      });
    }
    const byte = this.bytes[this.at] ?? 0;
    this.at += 1;
    if (byte !== 0xff) return byte;
    let next = this.bytes[this.at];
    while (next === 0xff) {
      this.at += 1; // repeated 0xFF ahead of a marker is fill, and carries no bits
      next = this.bytes[this.at];
    }
    if (next === 0x00) {
      this.at += 1; // `FF 00` is a stuffed literal 0xFF sample byte
      return 0xff;
    }
    this.at -= 1;
    throw imageDecodeFailed(
      next === undefined
        ? 'the entropy-coded data ends inside a marker (truncated JPEG)'
        : `marker FF${next.toString(16).toUpperCase().padStart(2, '0')} interrupts the scan ` +
            'before its last block was decoded',
      { at: this.at, marker: next ?? null },
    );
  }

  readBit(): number {
    if (this.count === 0) {
      this.buffer = this.nextByte();
      this.count = 8;
    }
    this.count -= 1;
    return (this.buffer >> this.count) & 1;
  }

  receive(length: number): number {
    let value = 0;
    for (let i = 0; i < length; i += 1) value = (value << 1) | this.readBit();
    return value;
  }

  /** T.81's EXTEND: an `length`-bit magnitude whose top bit is 0 is the negative half of the range. */
  receiveAndExtend(length: number): number {
    if (length === 0) return 0;
    const value = this.receive(length);
    return value < 1 << (length - 1) ? value - (1 << length) + 1 : value;
  }

  decode(table: HuffmanTable): number {
    let code = this.readBit();
    for (let length = 1; length <= 16; length += 1) {
      const max = table.maxcode[length] ?? -1;
      if (max >= 0 && code <= max) {
        const symbol =
          table.values[(table.valptr[length] ?? 0) + code - (table.mincode[length] ?? 0)];
        if (symbol === undefined) {
          throw imageDecodeFailed(
            `a ${length}-bit Huffman code resolves outside the symbols its table defines`,
            { length, code },
          );
        }
        return symbol;
      }
      if (length < 16) code = (code << 1) | this.readBit();
    }
    throw imageDecodeFailed('no Huffman code of 16 bits or fewer matches the entropy data', {
      code,
    });
  }

  /**
   * Byte-aligns and swallows one `RSTn` marker, reporting whether it was there. The bit buffer
   * dies with it: a restart interval exists precisely so a decoder can resynchronise mid-scan.
   */
  restart(): boolean {
    this.count = 0;
    this.buffer = 0;
    let at = this.at;
    while (this.bytes[at] === 0xff && this.bytes[at + 1] === 0xff) at += 1;
    const marker = this.bytes[at] === 0xff ? this.bytes[at + 1] : undefined;
    if (marker !== undefined && marker >= 0xd0 && marker <= 0xd7) {
      this.at = at + 2;
      return true;
    }
    return false;
  }
}
