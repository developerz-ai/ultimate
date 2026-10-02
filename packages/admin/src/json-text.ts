// A value as the JSON an operator READS: keys sorted so two equal values read alike, a bigint as
// its digits, an instant as ISO text. Total — `JSON.stringify` throws on a bigint, and a `money()`
// column puts one on the row. Never a hash form: `@ultimat3/core`'s `canonicalJson` spells a
// bigint `BigInt(2)` so two types cannot collide, which is right for a key and wrong for a screen.

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function text(value: unknown, seen: ReadonlySet<unknown>): string {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? String(value) : 'null';
    case 'boolean':
      return String(value);
    case 'bigint':
      return value.toString();
    case 'object':
      break;
    default:
      return 'null';
  }
  if (value === null) return 'null';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'null' : JSON.stringify(value.toISOString());
  }
  // A cycle has no JSON; the second visit is where it is cut, and it says so.
  if (seen.has(value)) return '"[circular]"';
  const inside = new Set(seen).add(value);
  if (Array.isArray(value)) return `[${value.map((one) => text(one, inside)).join(',')}]`;
  if (value instanceof Set) return text([...value], inside);
  const entries: readonly (readonly [string, unknown])[] =
    value instanceof Map
      ? [...value].map(([key, held]) => [String(key), held] as const)
      : Object.entries(value);
  return `{${[...entries]
    .filter(([, held]) => held !== undefined)
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([key, held]) => `${JSON.stringify(key)}:${text(held, inside)}`)
    .join(',')}}`;
}

/** `value` as deterministic, readable JSON text. */
export function jsonText(value: unknown): string {
  return text(value, new Set());
}

/** One value as a line of an audit diff or a detail row: text as it is, anything else as JSON. */
export function valueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : jsonText(value);
}
