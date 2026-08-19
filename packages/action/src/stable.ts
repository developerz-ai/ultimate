/**
 * Deterministic JSON in two forms, deliberately NOT one function. `stableStringify` is the
 * DOCUMENT form — `openapi.json` is published from it and `json-schema.ts` re-reads it with
 * `JSON.parse`, so a non-finite number must be `null` and a `Date` must be what `JSON.stringify`
 * makes of one. `canonicalJson` is the HASH form — it is only ever hashed, so it must be
 * INJECTIVE. One walk, three rules.
 */

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** How the two forms disagree, and the only things they disagree about. */
type NumberForm = (value: number) => string;

/** A `Date` is what `t.date` parses an input field INTO, so it is the exotic value that arrives. */
type DateForm = (value: Date) => string;

/**
 * `encode` is the walk itself: the hash form recurses through it, the document form ignores it and
 * so never descends into a collection it does not render.
 */
type CollectionForm = (
  value: Map<unknown, unknown> | Set<unknown>,
  encode: (item: unknown) => string,
) => string;

interface Form {
  readonly number: NumberForm;
  readonly date: DateForm;
  readonly collection: CollectionForm;
}

/** JSON's own rule: a non-finite number has no token in the grammar, so it is `null`. */
const jsonNumber: NumberForm = (value) => (Number.isFinite(value) ? String(value) : 'null');

/** `Date.prototype.toJSON` — the ISO string, and `null` for an Invalid Date. Both re-parse. */
const jsonDate: DateForm = (value) => JSON.stringify(value);

/** `JSON.stringify(new Map())` is `{}`: neither a Map nor a Set has an own enumerable key. */
const jsonCollection: CollectionForm = () => '{}';

/**
 * Bare tokens, never quoted and never `'null'`. This output is only ever hashed, so an unquoted
 * word cannot collide with the `string` branch (which always quotes), while `'null'` collided with
 * JSON `null` itself — `{ n: NaN }`, `{ n: Infinity }`, `{ n: -Infinity }` and `{ n: null }` were
 * one `requestHash` and therefore one idempotency record. `-0` is spelled out for the same reason:
 * `String(-0)` is `"0"`, so `-0` and `0` were one record too. The twin of `@ultimat3/query`'s rule
 * in its own `stable.ts`; both are tier 3, so neither can import the other.
 */
const hashNumber: NumberForm = (value) => {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
  return Object.is(value, -0) ? '-0' : String(value);
};

/**
 * The epoch, TAGGED — the same per-type tagging `hashNumber` uses for `NaN` and `-0`, for the same
 * reason. Untagged, a `t.date` field and a `t.number` field holding that field's epoch would be one
 * `requestHash`, which is the collision this form exists to refuse; an Invalid Date would be the
 * bare `NaN` token a `t.number` field already owns.
 */
const hashDate: DateForm = (value) => `Date(${hashNumber(value.getTime())})`;

/**
 * Tagged for the reason `hashDate` is: a `Map`, a `Set` and `{}` all have no own enumerable key,
 * so the object branch rendered all three `{}` and `fingerprint` answered one hash for three
 * payloads sharing nothing. Entries are SORTED, as an object's keys are: insertion order is not
 * part of what a Map or a Set holds, so two spellings of one payload stay one record.
 */
const hashCollection: CollectionForm = (value, encode) => {
  const entries =
    value instanceof Map
      ? [...value].map(([key, item]) => `${encode(key)}:${encode(item)}`)
      : [...value].map((item) => encode(item));
  return `${value instanceof Map ? 'Map' : 'Set'}(${entries.sort().join(',')})`;
};

const DOCUMENT_FORM: Form = { number: jsonNumber, date: jsonDate, collection: jsonCollection };
const HASH_FORM: Form = { number: hashNumber, date: hashDate, collection: hashCollection };

/** JSON with object keys sorted at every depth. No timestamps, no insertion-order leaks. */
export function stableStringify(value: unknown, indent = 0): string {
  return write(value, indent, 0, DOCUMENT_FORM);
}

/**
 * The canonical form a `fingerprint` is taken over. Byte-identical to `stableStringify(value)` for
 * any value carrying no `NaN`, no `±Infinity`, no `-0` and none of the three exotics below, which
 * is why no idempotency record and no job dedupe key issued before this moved.
 */
export function canonicalJson(value: unknown): string {
  return write(value, 0, 0, HASH_FORM);
}

function write(value: unknown, indent: number, depth: number, form: Form): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return form.number(value);
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
  if (value instanceof Date) return form.date(value);
  if (value instanceof Map || value instanceof Set) {
    return form.collection(value, (item) => write(item, indent, depth + 1, form));
  }
  const pad = indent > 0 ? '\n'.padEnd(1 + indent * (depth + 1), ' ') : '';
  const close = indent > 0 ? '\n'.padEnd(1 + indent * depth, ' ') : '';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => write(item, indent, depth + 1, form));
    return `[${pad}${items.join(`,${pad || ''}`)}${close}]`;
  }
  const record = value as JsonObject;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  if (keys.length === 0) return '{}';
  const gap = indent > 0 ? ' ' : '';
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${gap}${write(record[key], indent, depth + 1, form)}`,
  );
  return `{${pad}${entries.join(`,${pad || ''}`)}${close}}`;
}

/**
 * SHA-256, first 16 hex characters — the same primitive and width `@ultimat3/query`'s `fingerprint`
 * and `@ultimat3/realtime`'s `stableDigest` already chose, and for the same reason.
 *
 * A fingerprint here is a SHARING key over input a client chooses, not a checksum. It is the
 * `requestHash` that decides "same request, replay the stored response" and the job dedupe key
 * `job-handle.ts` files an enqueue under, so a collision hands one caller's stored response to a
 * different request, or drops an enqueue as a duplicate of a job it shares nothing with. FNV-1a/32
 * — what this was — is 4x10^9 values, brute-forceable offline in seconds, so a payload landing on
 * another request's hash was something an attacker could mint rather than something they had to
 * wait for.
 *
 * It is taken over `canonicalJson` and not `stableStringify` for the second half of the same
 * argument: the document form is not injective, so four distinct inputs shared one hash without
 * anyone having to mint anything.
 */
export function fingerprint(value: unknown): string {
  return new Bun.CryptoHasher('sha256').update(canonicalJson(value)).digest('hex').slice(0, 16);
}
