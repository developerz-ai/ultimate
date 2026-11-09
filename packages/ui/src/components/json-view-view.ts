// Any value to a tree `JsonView` draws as nested `<details>`: keys in the order given, a depth cap,
// a cycle named rather than followed, and what JSON cannot hold (a bigint, a function) as text.
// Never throws on content: a webhook body is whatever the sender sent.

export const JSON_VIEW_MAX_DEPTH = 12;
/** Entries past this many in one object or array fold into a count. */
export const JSON_VIEW_MAX_ENTRIES = 500;

export type JsonViewNode =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number' | 'boolean' | 'null' | 'other'; readonly value: string }
  | {
      readonly kind: 'object' | 'array';
      readonly entries: readonly (readonly [string, JsonViewNode])[];
      /** Entries left out past `JSON_VIEW_MAX_ENTRIES`. */
      readonly more: number;
      readonly size: number;
    }
  | { readonly kind: 'deep' | 'circular' };

export function jsonViewTree(
  value: unknown,
  depth = 0,
  seen: Set<object> = new Set(),
): JsonViewNode {
  if (value === null || value === undefined) return { kind: 'null', value: 'null' };
  if (typeof value === 'string') return { kind: 'string', value };
  if (typeof value === 'number')
    return { kind: 'number', value: Number.isFinite(value) ? String(value) : 'null' };
  if (typeof value === 'boolean') return { kind: 'boolean', value: String(value) };
  if (typeof value !== 'object') return { kind: 'other', value: String(value) };
  if (value instanceof Date)
    return {
      kind: 'string',
      value: Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString(),
    };
  if (seen.has(value)) return { kind: 'circular' };
  if (depth >= JSON_VIEW_MAX_DEPTH) return { kind: 'deep' };
  seen.add(value);
  const array = Array.isArray(value);
  const pairs: [string, unknown][] = array
    ? (value as readonly unknown[]).map((item, index) => [String(index), item])
    : Object.keys(value).map((key) => [key, (value as Record<string, unknown>)[key]]);
  const entries = pairs
    .slice(0, JSON_VIEW_MAX_ENTRIES)
    .map(([key, item]) => [key, jsonViewTree(item, depth + 1, seen)] as const);
  seen.delete(value);
  return {
    kind: array ? 'array' : 'object',
    entries,
    more: Math.max(0, pairs.length - JSON_VIEW_MAX_ENTRIES),
    size: pairs.length,
  };
}
