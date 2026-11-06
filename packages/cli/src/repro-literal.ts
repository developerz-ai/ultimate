// Single responsibility: a JSON value as a TypeScript literal in the repo's own style — single
// quotes, two spaces, trailing commas, keys bare where they can be — so a test `x repro --write`
// emits passes `lint` without a formatter and reads like a test someone wrote.

const BARE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const quoted = (text: string): string =>
  `'${text
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029')}'`;

/** `__proto__` written bare or quoted SETS the prototype; only a computed key stays a key. */
const keyOf = (key: string): string =>
  key === '__proto__' ? `[${quoted(key)}]` : BARE_KEY.test(key) ? key : quoted(key);

/** `value` rendered at `depth` (its first line is not indented; nested lines are). */
export function tsLiteral(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return quoted(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return String(value);
  const pad = '  '.repeat(depth + 1);
  const close = '  '.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((entry) => `${pad}${tsLiteral(entry, depth + 1)},`).join('\n')}\n${close}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    const lines = entries.map(
      ([key, entry]) => `${pad}${keyOf(key)}: ${tsLiteral(entry, depth + 1)},`,
    );
    return `{\n${lines.join('\n')}\n${close}}`;
  }
  return 'null';
}
