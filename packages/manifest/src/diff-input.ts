// An input schema's change, classified (`diffActions`, `diffQueries`, `diffJobs`): byte-identical
// is no change, and so is an `enum` reordered; ADDING optional top-level properties to a closed
// object schema, or ADDING values to an `enum` in a positive position, is `additive`, since every
// payload the old schema accepted the new one accepts; anything else is `breaking`.
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
    if (!Object.hasOwn(afterProps, name)) return false;
    if (canonicalJson(schema) !== canonicalJson(afterProps[name])) return false;
  }
  // Nothing newly required — an old property or a new one.
  const wasRequired = new Set(names(beforeRequired));
  return names(afterRequired).every((name) => wasRequired.has(name));
}

/** How `after` compares to `before` under {@link enumWidening}. */
export type EnumWidening = 'same' | 'wider' | 'other';

/** Keywords whose value is a schema (or a list of schemas) a payload must satisfy, not exclude. */
const SCHEMA_KEYWORDS = new Set(['items', 'additionalProperties', 'prefixItems', 'anyOf', 'allOf']);
/** Keywords whose value maps names to schemas, each one a positive position too. */
const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties']);

/** A reference keyword: it can reach a widened node from anywhere, a negative position too. */
const REF_KEYWORDS = new Set(['$ref', '$dynamicRef', '$recursiveRef']);

const refers = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.some(refers)
    : isJsonObject(value) &&
      Object.keys(value).some((key) => REF_KEYWORDS.has(key) || refers(value[key]));

const joined = (results: readonly EnumWidening[]): EnumWidening =>
  results.includes('other') ? 'other' : results.includes('wider') ? 'wider' : 'same';

const ownKeys = (value: Record<string, unknown>): string[] => Object.keys(value).sort();

const sameKeys = (before: Record<string, unknown>, after: Record<string, unknown>): boolean =>
  canonicalJson(ownKeys(before)) === canonicalJson(ownKeys(after));

/** A schema, or a list of schemas, compared position by position. */
const schemaOrList = (before: unknown, after: unknown): EnumWidening => {
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) return 'other';
    return joined(before.map((item, index) => enumWidening(item, after[index])));
  }
  return enumWidening(before, after);
};

/**
 * Whether `after` is `before` with values ADDED to `enum` lists and nothing else changed. Only a
 * positive position is followed — `properties`, `items`, `anyOf`, `allOf` and their like — where
 * accepting more at the node accepts more overall. `oneOf`, `not`, `if`, `const` and every other
 * keyword must match exactly: widening inside one can refuse a payload the old schema took. An
 * enum holding the same values in another order is `same`. A schema that refers (`$ref`) is never
 * judged wider by `diffInput`: the reference can reach the widened node from a negative position.
 */
export function enumWidening(before: unknown, after: unknown): EnumWidening {
  if (!isJsonObject(before) || !isJsonObject(after)) {
    return canonicalJson(before) === canonicalJson(after) ? 'same' : 'other';
  }
  if (!sameKeys(before, after)) return 'other';
  const results: EnumWidening[] = [];
  for (const key of ownKeys(before)) {
    const was = before[key];
    const now = after[key];
    if (key === 'enum' && Array.isArray(was) && Array.isArray(now)) {
      const old = new Set(was.map((value) => canonicalJson(value)));
      const offered = new Set(now.map((value) => canonicalJson(value)));
      if (![...old].every((value) => offered.has(value))) return 'other';
      results.push(offered.size > old.size ? 'wider' : 'same');
    } else if (SCHEMA_KEYWORDS.has(key)) {
      results.push(schemaOrList(was, now));
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && isJsonObject(was) && isJsonObject(now)) {
      if (!sameKeys(was, now)) return 'other';
      results.push(joined(ownKeys(was).map((name) => enumWidening(was[name], now[name]))));
    } else {
      results.push(canonicalJson(was) === canonicalJson(now) ? 'same' : 'other');
    }
  }
  return joined(results);
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
  const widening = enumWidening(before, after);
  if (widening === 'same') return [];
  // A `$ref` may reach the widened enum from a `not` or a `oneOf`: not judged, so breaking.
  if (widening === 'wider' && !refers(before)) {
    return [{ kind: 'additive', path, detail: 'input accepts more enum values' }];
  }
  return [{ kind: 'breaking', path, detail: breakingDetail }];
}
