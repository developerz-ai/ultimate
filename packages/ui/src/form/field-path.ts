// The ONE path grammar a form speaks, in both directions: the dotted, bracketed string a schema
// issue carries (`items[2].price`, rendered by `@ultimat3/schema`'s `formatPath`, never copied)
// and the `name` attribute the control renders.
//
// One grammar is what lets a rejection find its control at all — two would be a hand-written
// mapping table per form, which is the 40-forms-40-mappings cost this binding exists to delete.

export type FieldPathSegment = string | number;

/**
 * The largest index the grammar accepts. A form does not have ten thousand rows; a larger index is
 * a crafted `name`, and `valuesOfForm` would allocate the array it describes.
 */
export const MAX_FIELD_INDEX = 10_000;

const KEY = /^[A-Za-z_$][A-Za-z0-9_$]*/;
/** `[0]`, never `[01]`: an index that does not round-trip through schema's `formatPath` is not one. */
const INDEX = /^\[(0|[1-9][0-9]*)\]/;

/**
 * Keys that are not fields on any object an app owns. A control named `__proto__` reaching
 * `valuesOfForm` writes through the prototype of every object in the process — the same sink
 * `bun run proto-index` guards on the read side.
 */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * The reverse of `@ultimat3/schema`'s `formatPath`, or `null` for anything that is not a field path. Total and
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

/**
 * The attribute selector that finds a control by its field path, or `null` for a name that is not
 * one. The grammar above is the ALLOWLIST and the only thing between a caller's string and a
 * selector: `parseFieldPath` accepts `[A-Za-z_$][A-Za-z0-9_$]*`, `.` and `[0]` and nothing else, so
 * no name it returns a path for can carry a quote, a bracket it did not open, or a second selector.
 * Refused rather than escaped, for the same reason the parser is total — a name no issue can name
 * is a field whose errors land nowhere, and building a selector for it would hide that.
 */
export function fieldSelector(name: string): string | null {
  return parseFieldPath(name) === null ? null : `[name="${name}"]`;
}
