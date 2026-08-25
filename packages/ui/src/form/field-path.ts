// The ONE path grammar a form speaks, in both directions: the dotted, bracketed string a schema
// issue carries (`items[2].price`) and the `name` attribute the control renders. One grammar is
// what lets a rejection find its control at all — two would be a hand-written mapping table per
// form, which is the 40-forms-40-mappings cost this binding exists to delete.

/** A Standard Schema issue segment. Wrapped or bare — conforming libraries send both. */
export interface IssuePathSegment {
  readonly key: PropertyKey;
}

export type FieldPathSegment = string | number;

/**
 * The largest index the grammar accepts. A form does not have ten thousand rows; a larger index is
 * a crafted `name`, and `valuesOfForm` would allocate the array it describes.
 */
export const MAX_FIELD_INDEX = 10_000;

/**
 * Structural copy of `@ultimat3/schema`'s `formatPath`. **Keep in sync**: an issue that arrives
 * from the server was rendered by THAT function, so a divergence here is an error that lands on no
 * field. Copied rather than imported because `@ultimat3/ui` holds no dependency edge on
 * `@ultimat3/schema` — the tier table permits one, the manifest and the lockfile do not — the same
 * trade `@ultimat3/db`'s `entity-shape.ts` makes one tier down.
 */
export function formatFieldPath(
  path: readonly (PropertyKey | IssuePathSegment)[] | undefined,
): string {
  if (path === undefined || path.length === 0) return '';
  let out = '';
  for (const segment of path) {
    const key = typeof segment === 'object' ? segment.key : segment;
    if (typeof key === 'number') {
      out += `[${key}]`;
    } else {
      out += out === '' ? String(key) : `.${String(key)}`;
    }
  }
  return out;
}

const KEY = /^[A-Za-z_$][A-Za-z0-9_$]*/;
/** `[0]`, never `[01]`: an index that does not round-trip through `formatFieldPath` is not one. */
const INDEX = /^\[(0|[1-9][0-9]*)\]/;

/**
 * Keys that are not fields on any object an app owns. A control named `__proto__` reaching
 * `valuesOfForm` writes through the prototype of every object in the process — the same sink
 * `bun run proto-index` guards on the read side.
 */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * The reverse of `formatFieldPath`, or `null` for anything that is not a field path. Total and
 * silent by design: the caller decides whether an unusable name is a refusal (`valuesOfForm`, which
 * is building an object) or simply a path that matches no field (`distributeIssues`, which must
 * surface it and carry on).
 */
export function parseFieldPath(name: string): readonly FieldPathSegment[] | null {
  const segments: FieldPathSegment[] = [];
  let rest = name;
  let expectKey = true;

  while (rest.length > 0) {
    if (expectKey) {
      const match = KEY.exec(rest);
      if (match === null) return null;
      const key = match[0];
      if (UNSAFE_KEYS.has(key)) return null;
      segments.push(key);
      rest = rest.slice(key.length);
      expectKey = false;
      continue;
    }
    if (rest.startsWith('.')) {
      rest = rest.slice(1);
      expectKey = true;
      continue;
    }
    const match = INDEX.exec(rest);
    const digits = match?.[1];
    if (match === undefined || match === null || digits === undefined) return null;
    const index = Number(digits);
    if (index > MAX_FIELD_INDEX) return null;
    segments.push(index);
    rest = rest.slice(match[0].length);
  }

  // `expectKey` still set means the name ended on a `.` or was empty — both are half a path.
  return expectKey ? null : segments;
}
