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

/** Key-sorted JSON so a query id derived from input is stable across property order. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`);
  return `{${parts.join(',')}}`;
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
