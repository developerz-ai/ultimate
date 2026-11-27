// An input schema's change, classified (`diffActions`, `diffQueries`, `diffJobs`): byte-identical
// is no change; ADDING optional top-level properties to a closed object schema, or ADDING values to
// an `enum`, is `additive`, since every payload the old schema accepted the new one accepts;
// anything else is `breaking`.
//
// Deliberately shallow: only the top level is compared, so an optional property added INSIDE a
// nested object still reads as breaking — over-reporting is the safe side of a contract check.

import { canonicalJson, isJsonObject } from '@ultimat3/core';
import type { ManifestChange } from './diff-change';

const names = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** True when `after` accepts every payload `before` does, by only adding optional properties. */
export function onlyAddsOptionalProperties(before: unknown, after: unknown): boolean {
  if (!isJsonObject(before) || !isJsonObject(after)) return false;
  // Only a CLOSED schema: an open one (`additionalProperties` true or absent) already accepted any
  // extra key, so a new typed property can refuse a payload it used to take (`{ trigger: 123 }`).
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

/**
 * True when `after` is `before` with values ADDED to one or more `enum` lists and nothing else
 * changed: every payload the old schema accepted, the new one accepts (a webhook topic, a status a
 * filter takes). A removed value, or any other difference, is not this.
 */
export function onlyWidensEnums(before: unknown, after: unknown): boolean {
  if (Array.isArray(before) || Array.isArray(after)) {
    if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length)
      return false;
    return before.every((item, index) => onlyWidensEnums(item, after[index]));
  }
  if (!isJsonObject(before) || !isJsonObject(after))
    return canonicalJson(before) === canonicalJson(after);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const was = before[key];
    const now = after[key];
    if (key === 'enum' && Array.isArray(was) && Array.isArray(now)) {
      const offered = new Set(now.map((value) => canonicalJson(value)));
      if (!was.every((value) => offered.has(canonicalJson(value)))) return false;
      continue;
    }
    if (!(key in before) || !(key in after) || !onlyWidensEnums(was, now)) return false;
  }
  return true;
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
  if (onlyWidensEnums(before, after)) {
    return [{ kind: 'additive', path, detail: 'input accepts more enum values' }];
  }
  return [{ kind: 'breaking', path, detail: breakingDetail }];
}
