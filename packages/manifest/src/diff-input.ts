// An input schema's change, classified (`diffActions`, `diffQueries`, `diffJobs`): byte-identical
// is no change; only ADDING optional top-level properties to a CLOSED object schema is `additive`,
// since every payload the old schema accepted the new one accepts; anything else is `breaking`.
//
// Deliberately shallow: only the top level is compared, so an optional property added INSIDE a
// nested object still reads as breaking. Over-reporting is the safe side of a contract check.
//
// So `additive` is UNREACHABLE for a projected input, and that is deliberate. No projected schema is
// closed: `@ultimat3/schema`'s `json-schema.ts` publishes `additionalProperties: true` for the
// `object` and `money` cases, because the parser accepts an undeclared key and drops it. An open
// `before` proves nothing here: it took `{ trigger: 123 }` as an extra key, the new schema routes
// that key through the new typed property and refuses a payload it used to accept, so widening this
// predicate to an open `before` would report a refusal as `additive` and stop a contract check from
// firing. Every projected input that moves therefore reads `breaking`, an optional addition
// included; the kind stays for a hand-written closed schema, reachable only through a manifest that
// carries one. Reachability is not worth a missed refusal.

import { canonicalJson, isJsonObject } from '@ultimat3/core';
import type { ManifestChange } from './diff-change';

const names = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * True when `after` accepts every payload `before` does, by only adding optional properties. Only a
 * CLOSED `before` can prove it (`diff-input.test.ts` pins the open case as false); see the header for
 * why a projected input never qualifies.
 */
export function onlyAddsOptionalProperties(before: unknown, after: unknown): boolean {
  if (!isJsonObject(before) || !isJsonObject(after)) return false;
  // Only a CLOSED schema: an open one (`additionalProperties` true or absent) already accepted any
  // extra key, so a new typed property can refuse a payload it used to take (`{ trigger: 123 }`).
  // Every projected input is open, so this line is the whole reason no projected input is additive.
  if (before['additionalProperties'] !== false) return false;
  const beforeProps = before['properties'];
  const afterProps = after['properties'];
  if (!isJsonObject(beforeProps) || !isJsonObject(afterProps)) return false;
  // Everything but `properties` and `required` must be the same (type, additionalProperties, …).
  const { properties: _bp, required: beforeRequired, ...beforeRest } = before;
  const { properties: _ap, required: afterRequired, ...afterRest } = after;
  if (canonicalJson(beforeRest) !== canonicalJson(afterRest)) return false;
  // No property removed or changed.
  for (const [name, schema] of Object.entries(beforeProps)) {
    if (!(name in afterProps)) return false;
    if (canonicalJson(schema) !== canonicalJson(afterProps[name])) return false;
  }
  // Nothing newly required — an old property or a new one.
  const wasRequired = new Set(names(beforeRequired));
  return names(afterRequired).every((name) => wasRequired.has(name));
}

/** The change between two input schemas at `path`, or none. */
export function diffInput(
  path: string,
  before: unknown,
  after: unknown,
  breakingDetail: string,
): readonly ManifestChange[] {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  if (onlyAddsOptionalProperties(before, after)) {
    return [{ kind: 'additive', path, detail: 'input gained optional properties' }];
  }
  return [{ kind: 'breaking', path, detail: breakingDetail }];
}
