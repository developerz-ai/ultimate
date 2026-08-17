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

/** FNV-1a/32 as hex. Identity of a query shape, never a security boundary. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function fingerprint(value: unknown): string {
  return fnv1a(stableStringify(value));
}

/** Column read that works for interfaces without an index signature. */
export function columnOf(row: object, column: string): unknown {
  const record: unknown = row;
  return isJsonObject(record) ? record[column] : undefined;
}
