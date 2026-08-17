// Single responsibility: serialise a `SchemaDescription` as the JSON Biome would have printed.
// `x db gen` writes this file into an app whose `lint` step is `biome check .`, so a serialiser
// that is not a fixed point of the formatter is a framework that fails its own gate — which
// `JSON.stringify(…, null, 2)` was, on every snapshot carrying a one-element array.

import type { SchemaDescription } from './introspect';

/** What `x new` writes into the scaffold's `biome.json`, and what this repo's own config sets. */
const LINE_WIDTH = 100;
const INDENT = 2;

/**
 * Biome's two JSON rules, measured against 2.5.5 and the whole of this module:
 *
 * - an **object** keeps the source's shape — a line break after `{` stays broken, and `{}` stays
 *   inline — so emitting every non-empty object broken is stable by construction;
 * - an **array** collapses onto one line when every element is already on one line and the whole
 *   line fits, *counting the trailing comma*, at `<= LINE_WIDTH`.
 *
 * So the only arithmetic is the array's, and the only thing that can force an array open is a
 * non-empty object inside it.
 */
function expands(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(expands);
  if (typeof value === 'object' && value !== null) return Object.keys(value).length > 0;
  return false;
}

function inline(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inline).join(', ')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    const members = entries.map(([key, each]) => `${JSON.stringify(key)}: ${inline(each)}`);
    return `{ ${members.join(', ')} }`;
  }
  return JSON.stringify(value);
}

/**
 * `column` is what the line already holds before this value; `trailing` is what follows it on the
 * same line — 1 for the comma of a member that is not the last. Both exist only for the array rule.
 */
function print(value: unknown, depth: number, column: number, trailing: number): string {
  const pad = ' '.repeat(depth * INDENT);
  const inner = ' '.repeat((depth + 1) * INDENT);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const one = inline(value);
    if (!expands(value) && column + one.length + trailing <= LINE_WIDTH) return one;
    const items = value.map((each, index) => {
      const comma = index === value.length - 1 ? '' : ',';
      return `${inner}${print(each, depth + 1, inner.length, comma.length)}${comma}`;
    });
    return `[\n${items.join('\n')}\n${pad}]`;
  }

  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    const members = entries.map(([key, each], index) => {
      const label = `${JSON.stringify(key)}: `;
      const comma = index === entries.length - 1 ? '' : ',';
      const printed = print(each, depth + 1, inner.length + label.length, comma.length);
      return `${inner}${label}${printed}${comma}`;
    });
    return `{\n${members.join('\n')}\n${pad}}`;
  }

  return JSON.stringify(value);
}

/**
 * The sidecar's bytes, trailing newline included.
 *
 * Round-tripped through `JSON.parse(JSON.stringify(…))` first so the printer walks exactly the
 * value the reader will parse back: an `undefined` field disappears here rather than reaching a
 * printer that has no spelling for it.
 */
export function snapshotJson(snapshot: SchemaDescription): string {
  const plain: unknown = JSON.parse(JSON.stringify(snapshot));
  return `${print(plain, 0, 0, 0)}\n`;
}
