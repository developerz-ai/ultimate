// A write's public name: the digest of the idempotency key the page sent it under. The server
// stamps it on every `records` frame the write produced; the page computes the same digest from
// its own key, so it can tell its own echo from somebody else's change. A digest, never the key:
// a frame fans out to every member of the channel, and the key is only the writer's to show.

/** Hex characters kept from the SHA-256: 128 bits, no collision between two writes in flight. */
export const WRITE_DIGEST_LENGTH = 32;

const WRITE_DIGEST_SHAPE = /^[0-9a-f]{32}$/;

/** Whether `value` is a write digest as this module mints one — what a decoder admits. */
export function isWriteDigest(value: unknown): value is string {
  return typeof value === 'string' && WRITE_DIGEST_SHAPE.test(value);
}

/**
 * SHA-256 of the key, hex, first `WRITE_DIGEST_LENGTH` characters. `undefined` where the runtime
 * has no `crypto.subtle` — a browser page served over plain HTTP from a host that is not
 * `localhost`. The page then names none of its writes and every frame is a plain merge, which is
 * the behaviour before frames named their write: a flicker at worst, never a wrong row.
 */
export async function writeDigest(key: string): Promise<string | undefined> {
  const subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle;
  if (subtle === undefined) return undefined;
  const bytes = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(key)));
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex.slice(0, WRITE_DIGEST_LENGTH);
}
