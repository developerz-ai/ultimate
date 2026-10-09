/**
 * Which values of an answer were instants. `JSON.stringify` writes a `Date` as its ISO string and
 * nothing on the far side can tell it from text, so a read's row typed `Date` reached its caller as
 * a string — and every app converted at its own edge (`wireDate()`). The server knows: it walks the
 * answer once, names each `Date` by its path in `x-ultimate-dates`, and `clientTransport` turns
 * exactly those strings back into `Date`s. The body is unchanged, so a client that ignores the
 * header reads what it always read.
 *
 * A path is a list of segments: a string is an object key, a number an array index, and `null`
 * EVERY element of an array — what a list of rows folds to (`[[null, "publishedAt"]]`), so the
 * header is one entry per column, not per row. A pattern that also matches a string that was not a
 * `Date` is never folded: its instants are sent by exact path, so revival is exact either way.
 */

/** The response header naming an answer's instants. Absent when it holds none. */
export const DATES_HEADER = 'x-ultimate-dates';

type Segment = string | number | null;

interface Pattern {
  readonly exact: Segment[][];
  /** A string that was not a `Date` sits at this pattern too, so folding it would revive text. */
  text: boolean;
}

const isWalkable = (value: unknown): value is object =>
  typeof value === 'object' &&
  value !== null &&
  // `JSON.stringify` writes what `toJSON` answers, not the object's keys — nothing to name inside.
  typeof (value as { toJSON?: unknown }).toJSON !== 'function';

/**
 * The header value for an answer, or `undefined` when it holds no `Date`. URI-encoded JSON: a
 * header value is bytes, and an object key may be any string.
 */
export function wireDatePaths(value: unknown): string | undefined {
  const patterns = new Map<string, Pattern>();
  const ancestors = new Set<object>();
  const at = (pattern: Segment[]): Pattern => {
    const key = JSON.stringify(pattern);
    const found = patterns.get(key) ?? { exact: [], text: false };
    patterns.set(key, found);
    return found;
  };
  const walk = (node: unknown, pattern: Segment[], exact: Segment[]): void => {
    if (node instanceof Date) {
      if (!Number.isNaN(node.getTime())) at(pattern).exact.push(exact);
      return;
    }
    if (typeof node === 'string') {
      at(pattern).text = true;
      return;
    }
    // A cycle is `JSON.stringify`'s refusal to make, one step later — never a stack overflow here.
    if (!isWalkable(node) || ancestors.has(node)) return;
    ancestors.add(node);
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        walk(node[index], [...pattern, null], [...exact, index]);
      }
    } else {
      for (const [key, item] of Object.entries(node))
        walk(item, [...pattern, key], [...exact, key]);
    }
    ancestors.delete(node);
  };
  walk(value, [], []);
  const paths: Segment[][] = [];
  for (const [key, { exact, text }] of patterns) {
    if (exact.length === 0) continue;
    if (text) paths.push(...exact);
    else paths.push(JSON.parse(key) as Segment[]);
  }
  return paths.length === 0 ? undefined : encodeURIComponent(JSON.stringify(paths));
}

/**
 * Every string the header names, in a freshly parsed answer, turned back into a `Date` — in place.
 * A header that does not parse revives nothing: it is a statement about the body, and a proxy that
 * mangled it has not mangled the body.
 */
export function reviveWireDates<T>(value: T, header: string | null): T {
  if (header === null || header === '') return value;
  let paths: unknown;
  try {
    paths = JSON.parse(decodeURIComponent(header));
  } catch {
    return value;
  }
  if (!Array.isArray(paths)) return value;
  const holder: { root: unknown } = { root: value };
  for (const path of paths) if (Array.isArray(path)) revive(holder, 'root', path, 0);
  return holder.root as T;
}

function revive(parent: object, key: string | number, path: readonly unknown[], depth: number) {
  const node: unknown = (parent as Record<string | number, unknown>)[key];
  if (depth === path.length) {
    if (typeof node !== 'string') return;
    const instant = new Date(node);
    if (!Number.isNaN(instant.getTime()))
      (parent as Record<string | number, unknown>)[key] = instant;
    return;
  }
  const segment = path[depth];
  if (Array.isArray(node)) {
    if (segment === null) for (let i = 0; i < node.length; i += 1) revive(node, i, path, depth + 1);
    else if (typeof segment === 'number' && segment < node.length)
      revive(node, segment, path, depth + 1);
  } else if (typeof node === 'object' && node !== null && typeof segment === 'string') {
    // `JSON.parse` mints `__proto__` as an own key, and assigning through it sets the prototype.
    if (segment !== '__proto__' && Object.hasOwn(node, segment)) {
      revive(node, segment, path, depth + 1);
    }
  }
}
