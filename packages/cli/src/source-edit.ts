// The two text edits a generator makes to a file the app owns: one keyed line added to an object
// literal, and one import added where the formatter's sorted block would have it. Shared by the
// registrars (`handle-registration.ts`, `admin-registration.ts`) so "in key order, expanded" means
// one thing in both.

const IDENTIFIER = '[A-Za-z_$][\\w$]*';

const keyOf = (item: string): string => item.split(':')[0]?.trim() ?? '';

/** Whether the object body already holds `key` — as `key: value` or as a shorthand. */
export const holdsKey = (body: string, key: string): boolean =>
  new RegExp(`(^|[\\s,{])${key}\\s*[:,]`).test(`${body},`);

/**
 * An object literal's body with `line` on its own row, in key order. A body the author keeps on
 * one line is expanded — an expanded literal is the shape a formatter leaves alone at any length.
 * `indent` is what an entry of this literal is indented by.
 */
export function withKeyedLine(body: string, key: string, line: string, indent: string): string {
  if (!body.includes('\n')) {
    const items = body
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    const lines = [...items.map((item) => `${indent}${item},`), line].sort((a, b) =>
      keyOf(a) < keyOf(b) ? -1 : 1,
    );
    return `\n${lines.join('\n')}\n${indent.slice(2)}`;
  }
  const lines = body.split('\n');
  const isEntry = (text: string): boolean => new RegExp(`^\\s*${IDENTIFIER}\\s*[:,]`).test(text);
  const after = lines.findIndex((text) => isEntry(text) && keyOf(text) > key);
  // Past the last entry when none sorts later: the row before the closing brace's own indent.
  lines.splice(after === -1 ? lines.length - 1 : after, 0, line);
  return lines.join('\n');
}

/** `source` with `line` imported, placed where a sorted import block would have it. */
export function withSortedImport(source: string, line: string, specifier: string): string {
  if (source.includes(`from '${specifier}'`)) return source;
  const imports = [...source.matchAll(/^import\b[^;]*?from\s+'([^']+)';\n/gm)];
  // Packages only: a relative import is a LATER group, so it is never what this line sorts against.
  const packages = imports.filter((match) => !(match[1] ?? '').startsWith('.'));
  const later = packages.find((match) => (match[1] ?? '') > specifier);
  const last = packages.at(-1);
  const first = imports[0]?.index ?? 0;
  const at = later?.index ?? (last === undefined ? first : last.index + last[0].length);
  return `${source.slice(0, at)}${line}\n${source.slice(at)}`;
}
