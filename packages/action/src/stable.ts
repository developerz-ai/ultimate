/**
 * Deterministic JSON, DOCUMENT form. `serializeOpenApi` publishes this string as `openapi.json`
 * and `json-schema.ts` re-reads it with `JSON.parse`, so what it emits must be valid JSON: a
 * non-finite number is `null` and a `Date` is what `JSON.stringify` makes of one.
 *
 * The HASH form is `@ultimat3/core`'s `canonicalJson`, and the two are deliberately NOT one
 * function. That one must be INJECTIVE, so it emits bare `NaN` / `Infinity` / `-0` tokens and tags
 * a `Date`, a `Map` and a `Set` — none of which parses, which is exactly why it may not be
 * published. Ordinary payloads are byte-identical between the two; `stable.test.ts` pins that.
 */

/**
 * `@ultimat3/core`'s, re-exported so `./stable` stays this package's one import path for the JSON
 * helpers. It was declared here AND identically in `@ultimat3/query`'s own `stable.ts`, which is
 * the duplication `client-wire.ts` moving to tier 0 made unnecessary.
 */
export { isJsonObject } from '@ultimat3/core';

export type JsonObject = Record<string, unknown>;

/** JSON with object keys sorted at every depth. No timestamps, no insertion-order leaks. */
export function stableStringify(value: unknown, indent = 0): string {
  return write(value, indent, 0);
}

function write(value: unknown, indent: number, depth: number): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    // JSON's own rule: a non-finite number has no token in the grammar, so it is `null`.
    case 'number':
      return Number.isFinite(value) ? String(value) : 'null';
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
  // is empty for all of them, so the branch below would answer `{}` for a date as well. What each
  // becomes is `JSON.stringify`'s own answer — the ISO string (`null` for an Invalid Date), and
  // `{}` for a Map and a Set — because this string is published and re-parsed.
  if (value instanceof Date) return JSON.stringify(value);
  if (value instanceof Map || value instanceof Set) return '{}';
  const pad = indent > 0 ? '\n'.padEnd(1 + indent * (depth + 1), ' ') : '';
  const close = indent > 0 ? '\n'.padEnd(1 + indent * depth, ' ') : '';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => write(item, indent, depth + 1));
    return `[${pad}${items.join(`,${pad || ''}`)}${close}]`;
  }
  const record = value as JsonObject;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  if (keys.length === 0) return '{}';
  const gap = indent > 0 ? ' ' : '';
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${gap}${write(record[key], indent, depth + 1)}`,
  );
  return `{${pad}${entries.join(`,${pad || ''}`)}${close}}`;
}
