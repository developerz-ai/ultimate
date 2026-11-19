// The catalog half of `x merge-driver`: a three-way merge of the JSON, key by key. Lines cannot do
// it — the entry before an addition gains a comma on both sides. Two values for one key stay a
// conflict: which wording ships is a decision, and this file does not make decisions.

import { isJsonObject } from '@ultimat3/core';
import type { JsonObject } from './json-merge';
import { sortJsonDeep } from './json-merge';

const CONFLICT = Symbol('conflict');
const ABSENT = Symbol('absent');

const same = (a: unknown, b: unknown): boolean => Bun.deepEquals(a, b, true);

function mergeValue(base: unknown, ours: unknown, theirs: unknown): unknown {
  if (same(ours, theirs) || same(theirs, base)) return ours;
  if (same(ours, base)) return theirs;
  if (!isJsonObject(ours) || !isJsonObject(theirs)) return CONFLICT;
  return mergeObject(isJsonObject(base) ? base : {}, ours, theirs);
}

function mergeObject(base: JsonObject, ours: JsonObject, theirs: JsonObject): unknown {
  const merged: [string, unknown][] = [];
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const read = (side: JsonObject): unknown => (Object.hasOwn(side, key) ? side[key] : ABSENT);
    const value = mergeValue(read(base), read(ours), read(theirs));
    if (value === CONFLICT) return CONFLICT;
    if (value !== ABSENT) merged.push([key, value]);
  }
  return Object.fromEntries(merged);
}

const parsed = (text: string): JsonObject | undefined => {
  try {
    const value: unknown = JSON.parse(text.trim() === '' ? '{}' : text);
    return isJsonObject(value) ? value : undefined;
  } catch {
    // Not JSON is an answer here: the caller falls back to a text merge, with markers.
    return undefined;
  }
};

const isSortedDeep = (value: unknown): boolean =>
  JSON.stringify(value) === JSON.stringify(sortJsonDeep(value));

/**
 * The merged catalog as `x g` prints one, or `undefined` when a side is not JSON or two sides
 * disagree on a key. Sorted where both sides were, which is every catalog a generator wrote, so
 * the merge order leaves no trace; a hand-grouped catalog keeps its order, the other side's new
 * keys after it.
 */
export function mergeCatalogText(base: string, ours: string, theirs: string): string | undefined {
  const [b, o, t] = [parsed(base), parsed(ours), parsed(theirs)];
  if (b === undefined || o === undefined || t === undefined) return undefined;
  const merged = mergeObject(b, o, t);
  if (merged === CONFLICT) return undefined;
  const value = isSortedDeep(o) && isSortedDeep(t) ? sortJsonDeep(merged) : merged;
  return `${JSON.stringify(value, null, 2)}\n`;
}
