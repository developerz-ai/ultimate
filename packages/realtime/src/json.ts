// The JSON value domain shared by the wire, the matcher, and the local store.
// Kept dependency-free so every other module in this package can import it without a cycle.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** Every row that crosses the wire or lands in the local store is identified by `id`. */
export type Row = JsonObject & { id: string };

export type RowOp = 'insert' | 'update' | 'delete';

/**
 * The minimal delta for one row in one subscription's result set.
 * `index` is present only for ordered result sets, so a client can splice instead of re-sort.
 */
export interface RowPatch {
  readonly op: RowOp;
  readonly id: string;
  /** `null` for deletes. For updates this is the changed columns only, never the whole row. */
  readonly row: JsonObject | null;
  readonly lsn: string;
  readonly index?: number;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRow(value: unknown): value is Row {
  return isJsonObject(value) && typeof value['id'] === 'string';
}

/** Shallow diff used to keep update patches minimal — the pipeline never ships unchanged columns. */
export function changedColumns(before: JsonObject | null, after: JsonObject): JsonObject {
  if (before === null) return after;
  const out: JsonObject = {};
  for (const key of Object.keys(after)) {
    const next = after[key];
    if (next === undefined) continue;
    if (!sameJson(before[key], next)) out[key] = next;
  }
  return out;
}

/**
 * Key-sorted JSON so a query id derived from input is stable across property order — and
 * INJECTIVE, because that id decides who shares a window.
 *
 * `qidOf` is `stableDigest(canonicalJson(input))` and a qid HIT hands the joiner the existing
 * entry: the first subscriber's compiled source, its matcher and its seated rows. Two inputs that
 * canonicalise to one string are therefore two clients served out of one window. `JSON.stringify`
 * is not injective over numbers — `NaN` and `±Infinity` are both `"null"`, which also collides
 * with JSON `null` itself, and `-0` is `"0"` — so the number branch is spelled out here.
 *
 * `-0` is the one of those a client can put on the wire (`JSON.parse('{"a":-0}')` answers `-0`);
 * the non-finite three have no JSON spelling and arrive only from a caller building `input` in JS,
 * such as `useLive(feed, () => ({ limit: Number.parseInt(raw) }))` on an unparseable `raw`.
 * The tokens are bare, never quoted: this output is only ever hashed, and the `string` branch
 * always quotes, so an unquoted word cannot collide with the text that spells it.
 *
 * The twin of `@ultimat3/query`'s and `@ultimat3/action`'s rules in their own `stable.ts`. All
 * three are tier 3, so no two of them can import each other; the shared home is `@ultimat3/core`
 * if one is ever made.
 */
export function canonicalJson(value: JsonValue): string {
  if (typeof value === 'number') return canonicalNumber(value);
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`);
  return `{${parts.join(',')}}`;
}

/** Ordinary numbers are `String(n)`, byte-identical to what this emitted before. */
function canonicalNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
  return Object.is(value, -0) ? '-0' : String(value);
}

/**
 * SHA-256, first 16 hex characters. For the hashes that are also SHARING keys — a `qid` decides
 * which subscribers are served from one window, and it is derived from input a client chooses, so
 * the 32 bits `fnv1a` answers are a collision anyone can find offline in seconds. Same primitive
 * and same width `@ultimat3/entity`'s `planScope` already chose for a cursor's scope.
 */
export function stableDigest(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 16);
}

/** FNV-1a, 32-bit, hex. Not cryptographic — it identifies and detects drift, it does not protect. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function sameJson(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
