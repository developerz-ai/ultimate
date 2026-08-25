// What the browser submitted, shaped the way the action's input schema declares it. The `name`
// attribute and the issue path are the SAME string, which is what makes a rejection findable: a
// control named `items[0].price` is the value at `items[0].price` and the error on it.
//
// A form is user input reaching an object graph, so a name is refused, never repaired.

import { conflictingFieldNameError, invalidFieldPathError } from '../errors';
import { type FieldPathSegment, formatFieldPath, parseFieldPath } from './field-path';

type Container = Record<string, unknown> | readonly unknown[];

function asContainer(value: unknown): Container | null {
  if (Array.isArray(value)) return value as readonly unknown[];
  if (typeof value === 'object' && value !== null) return value as Record<string, unknown>;
  return null;
}

/** `Object.hasOwn` rather than the bare read: the key is a `name` attribute, which is data. */
function childOf(container: Container, segment: FieldPathSegment): unknown {
  if (Array.isArray(container)) {
    return typeof segment === 'number' ? container[segment] : undefined;
  }
  const record = container as Record<string, unknown>;
  return typeof segment === 'string' && Object.hasOwn(record, segment)
    ? record[segment]
    : undefined;
}

function writeChild(container: Container, segment: FieldPathSegment, value: unknown): boolean {
  if (Array.isArray(container)) {
    if (typeof segment !== 'number') return false;
    (container as unknown[])[segment] = value;
    return true;
  }
  if (typeof segment !== 'string') return false;
  (container as Record<string, unknown>)[segment] = value;
  return true;
}

/**
 * One entry into the tree. Every branch that cannot continue throws: a name that describes an
 * object where another name already put a string is two controls fighting over one path, and
 * either winner silently discards something the user typed.
 */
function place(
  container: Container,
  segments: readonly FieldPathSegment[],
  value: unknown,
  name: string,
  prefix: readonly FieldPathSegment[],
): void {
  const [head, ...rest] = segments;
  // `parseFieldPath` never answers an empty list, so this is the type's obligation, not a case.
  if (head === undefined) return;
  const at = (): string => formatFieldPath([...prefix, head]);
  const existing = childOf(container, head);
  const next = rest[0];

  if (next === undefined) {
    if (existing !== undefined) throw conflictingFieldNameError(name, at());
    if (!writeChild(container, head, value)) throw conflictingFieldNameError(name, at());
    return;
  }

  const wantsArray = typeof next === 'number';
  const child = existing === undefined ? (wantsArray ? [] : {}) : asContainer(existing);
  if (child === null || Array.isArray(child) !== wantsArray) {
    throw conflictingFieldNameError(name, at());
  }
  if (existing === undefined && !writeChild(container, head, child)) {
    throw conflictingFieldNameError(name, at());
  }
  place(child, rest, value, name, [...prefix, head]);
}

/**
 * `new FormData(event.currentTarget)` as the object the typed client posts.
 *
 * A name that appears more than once collects into an array in document order — a `<select
 * multiple>` and a checkbox group have one name and many values, and no index to write. A field
 * that must ALWAYS be an array is named with explicit indexes (`tags[0]`, `tags[1]`), because one
 * checked box out of a group is otherwise a single value, which is what HTML submits.
 */
export function valuesOfForm(data: FormData): Record<string, unknown> {
  const grouped = new Map<string, unknown[]>();
  for (const [name, value] of data) {
    const held = grouped.get(name);
    if (held === undefined) grouped.set(name, [value]);
    else held.push(value);
  }

  const root: Record<string, unknown> = {};
  for (const [name, values] of grouped) {
    const segments = parseFieldPath(name);
    if (segments === null) throw invalidFieldPathError('form control', name);
    const [only] = values;
    place(root, segments, values.length === 1 && only !== undefined ? only : values, name, []);
  }
  return root;
}
