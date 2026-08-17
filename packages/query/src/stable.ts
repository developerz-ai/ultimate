/**
 * Deterministic JSON plus a content hash. Query hashes, cursor payloads and
 * cache keys all need byte-stable serialization, so nothing here may depend on
 * key insertion order.
 */

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    // A bare token, never `'null'` and never a quoted string: this output is only ever hashed, so
    // an unquoted word cannot collide with the `string` branch (which always quotes) while
    // `'null'` collided with JSON `null` itself — `{ n: NaN }`, `{ n: Infinity }` and `{ n: null }`
    // fingerprinted identically and shared one cache entry and one cursor scope. `-0` is spelled
    // out for the same reason: `String(-0)` is `"0"`, so `-0` and `0` were one key too.
    case 'number':
      if (Number.isNaN(value)) return 'NaN';
      if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
      return Object.is(value, -0) ? '-0' : String(value);
    case 'boolean':
      return String(value);
    case 'bigint':
      return JSON.stringify(`${value}n`);
    case 'undefined':
    case 'function':
    case 'symbol':
      return 'null';
    default:
      break;
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * SHA-256, first 16 hex characters — the same primitive and the same width `@ultimat3/realtime`'s
 * `stableDigest` and `@ultimat3/entity`'s `planScope` already chose, and for the same reason.
 *
 * A fingerprint is a SHARING key, not a checksum: it decides which read-cache entry two callers
 * are served from and which scope a cursor is bound to, over input a client chooses. FNV-1a/32 —
 * what this was — is 4x10^9 values, brute-forceable offline in seconds, so an attacker could mint
 * an input that lands on another read's entry or another page's scope. It identifies, and here
 * identifying IS the boundary.
 *
 * The canonical form above is unchanged, so the only thing that moved is the hash: a cursor issued
 * before this fails its scope check as `X_CURSOR_INVALID` — cleanly, with "request the first page
 * again" as its fix — and a warm read cache is cold once.
 */
export function fingerprint(value: unknown): string {
  return new Bun.CryptoHasher('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}

/** Column read that works for interfaces without an index signature. */
export function columnOf(row: object, column: string): unknown {
  const record: unknown = row;
  return isJsonObject(record) ? record[column] : undefined;
}
