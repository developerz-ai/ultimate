// Single responsibility: identifier generation. UUIDv7 is the framework default because
// database indexes, cursors and log sorting all want time-ordered keys.

import { type Clock, systemClock } from './clock';
import { UltimateError } from './errors';

/** Nominal typing without a runtime cost. `Brand<string, 'post'>` never mixes with `'user'`. */
export type Brand<T, K extends string> = T & { readonly __brand: K };

/** A branded UUIDv7 for entity `K`. */
export type Id<K extends string> = Brand<string, K>;

const HEX = '0123456789abcdef';
/** Exactly 64 URL-safe characters, so `byte & 63` is unbiased and never lands out of range. */
const NANO_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 12-bit counter lives in `rand_a`, seeded low so ~3k ids/ms fit before it overflows. */
const COUNTER_SEED_MASK = 0x3ff;
const COUNTER_MAX = 0xfff;

let lastEpochMs = -1;
let counter = 0;

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * A full 10 bits, from both bytes. Reading `bytes[0]` alone masked an 8-bit value with a 10-bit
 * mask, so the seed only ever reached 255 while `COUNTER_SEED_MASK` declared 1023 — the constant
 * and the code disagreed, and the second byte was allocated on every `uuid()` for nothing.
 */
function seedCounter(): number {
  const bytes = randomBytes(2);
  return (((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)) & COUNTER_SEED_MASK;
}

export function randomHex(byteLength: number): string {
  const bytes = randomBytes(byteLength);
  let out = '';
  for (const byte of bytes) {
    out += HEX[byte >> 4];
    out += HEX[byte & 0x0f];
  }
  return out;
}

/**
 * UUIDv7 per RFC 9562: 48-bit unix ms, version 7, 12-bit monotonic counter, 62 random bits.
 * Strictly increasing lexicographically even within the same millisecond, and never goes
 * backwards when the wall clock does.
 */
export function uuid(clock: Clock = systemClock): string {
  let epochMs = clock.now().getTime();
  if (epochMs < lastEpochMs) epochMs = lastEpochMs;

  if (epochMs === lastEpochMs) {
    counter += 1;
    if (counter > COUNTER_MAX) {
      epochMs += 1;
      counter = seedCounter();
    }
  } else {
    counter = seedCounter();
  }
  lastEpochMs = epochMs;

  const timeHex = epochMs.toString(16).padStart(12, '0').slice(-12);
  const randA = counter.toString(16).padStart(3, '0');
  const tail = randomHex(8);
  // Force the RFC variant bits (0b10) into the first nibble of `rand_b`.
  // charAt, not [], because the index is provably 0x8–0xb: a non-null assertion here would be
  // unenforceable style debt in the one file that made `noNonNullAssertion` unraisable.
  const variantNibble = HEX.charAt((Number.parseInt(tail.charAt(0), 16) & 0x3) | 0x8);

  return [
    timeHex.slice(0, 8),
    timeHex.slice(8, 12),
    `7${randA}`,
    `${variantNibble}${tail.slice(1, 4)}`,
    tail.slice(4, 16).padEnd(12, '0'),
  ].join('-');
}

export function isUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Recover the generation instant from a v7 id — cheap debugging and cursor windows. */
export function uuidTimestamp(id: string): Date {
  if (!isUuid(id)) {
    throw new UltimateError({
      code: 'X_ID_INVALID',
      cause: `"${id}" is not a UUIDv7`,
      fix: 'generate ids with uuid() from @ultimat3/core',
      meta: { id },
    });
  }
  return new Date(Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16));
}

/** URL-safe random id. Not sortable — use it for tokens and slugs, never primary keys. */
export function nanoid(length = 21): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) out += NANO_ALPHABET[byte & 63] as string;
  return out;
}

/** `typedId<'post'>()` — a UUIDv7 branded so it cannot be passed where a user id is wanted. */
export function typedId<K extends string>(clock: Clock = systemClock): Id<K> {
  return uuid(clock) as Id<K>;
}

/** Validate an untrusted string into a branded id. Throws `X_ID_INVALID`. */
export function parseId<K extends string>(kind: K, value: unknown): Id<K> {
  if (!isUuid(value)) {
    throw new UltimateError({
      code: 'X_ID_INVALID',
      cause: `expected a ${kind} UUIDv7, received ${JSON.stringify(value)}`,
      fix: `pass an id produced by typedId<'${kind}'>()`,
      meta: { kind, value },
    });
  }
  return value as Id<K>;
}

/** W3C trace-context ids: 16 bytes / 8 bytes of hex. */
export function traceId(): string {
  return randomHex(16);
}

export function spanId(): string {
  return randomHex(8);
}

/** Test-only: reset the monotonic counter so a frozen clock produces a fresh sequence. */
export function resetIdCounter(): void {
  lastEpochMs = -1;
  counter = 0;
}
