/**
 * The INJECTIVE canonical form of a value, and the sharing key taken over it.
 *
 * Tier 0 because three tier-3 packages need exactly this and none of them may import another:
 * `@ultimat3/action`'s `requestHash` and job dedupe key, `@ultimat3/query`'s `queryHash` (the
 * read-cache entry, the cursor scope, the live query id) and `@ultimat3/realtime`'s `qid`. Each
 * kept its own copy, and the copies had already diverged — query's rendered every `Date` as `{}`,
 * so one key answered for every date window a read ever served.
 *
 * Injective is the whole requirement: every one of those keys decides which of two callers is
 * served the other's answer, so two distinct inputs sharing one string is a leak and not a
 * collision. Nothing here is ever parsed back — `@ultimat3/action`'s `stableStringify` is the
 * DOCUMENT form for that, and it is a different function on purpose.
 */

/**
 * Bare tokens, never quoted and never `'null'`. This output is only ever hashed, so an unquoted
 * word cannot collide with the `string` branch (which always quotes), while `'null'` collided with
 * JSON `null` itself — `{ n: NaN }`, `{ n: Infinity }`, `{ n: -Infinity }` and `{ n: null }` were
 * one key and therefore one idempotency record, one cache entry and one cursor scope. `-0` is
 * spelled out for the same reason: `String(-0)` is `"0"`.
 */
function hashNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
  return Object.is(value, -0) ? '-0' : String(value);
}

/**
 * The epoch, TAGGED — the same per-type tagging `hashNumber` uses for `NaN` and `-0`, for the same
 * reason. Untagged, a `t.date` field and a `t.number` field holding that field's epoch would be one
 * key, which is the collision this form exists to refuse; an Invalid Date would be the bare `NaN`
 * token a `t.number` field already owns.
 */
function hashDate(value: Date): string {
  return `Date(${hashNumber(value.getTime())})`;
}

/**
 * Tagged for the reason a `Date` is: a `Map`, a `Set` and `{}` all have no own enumerable key, so
 * the object branch rendered all three `{}` and one hash answered for three payloads sharing
 * nothing. Entries are SORTED, as an object's keys are: insertion order is not part of what a Map
 * or a Set holds, so two spellings of one payload stay one key.
 */
function hashCollection(value: Map<unknown, unknown> | Set<unknown>): string {
  const entries =
    value instanceof Map
      ? [...value].map(([key, item]) => `${canonicalJson(key)}:${canonicalJson(item)}`)
      : [...value].map((item) => canonicalJson(item));
  return `${value instanceof Map ? 'Map' : 'Set'}(${entries.sort().join(',')})`;
}

/**
 * JSON with object keys sorted at every depth, and every value a JSON document would fold onto
 * `null` or `{}` given a token of its own. No timestamps, no insertion-order leaks.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return hashNumber(value);
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
  // Ahead of the object branch, because none of the three has an own enumerable key: `Object.keys`
  // is empty for all of them and the branch below would answer `{}` for every date, every map and
  // every set alike.
  if (value instanceof Date) return hashDate(value);
  if (value instanceof Map || value instanceof Set) return hashCollection(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * SHA-256, first 16 hex characters — the same primitive and width `@ultimat3/entity`'s `planScope`
 * already chose, and for the same reason.
 *
 * This is a SHARING key over input a client chooses, not a checksum. It decides "same request,
 * replay the stored response", which read-cache entry two callers are served from, which scope a
 * cursor is bound to and which subscribers are served out of one live window — so a collision
 * hands one caller another's rows. FNV-1a/32, which two of the three copies started as, is
 * 4x10^9 values and brute-forceable offline in seconds: an input landing on another read's key was
 * something an attacker could mint rather than something they had to wait for.
 */
export function fingerprint(value: unknown): string {
  return new Bun.CryptoHasher('sha256').update(canonicalJson(value)).digest('hex').slice(0, 16);
}
