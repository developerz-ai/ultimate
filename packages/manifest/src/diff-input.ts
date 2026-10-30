// An input schema's change, classified (`diffActions`, `diffJobs`): byte-identical is no change; a
// change that only ADDS optional top-level properties to an object schema is `additive` — every
// payload the old schema accepted, the new one accepts — and anything else is `breaking`. Read
// before this file existed as "any difference is breaking", an optional field added to a published
// action (a caller's new `trigger?`) made a consumer bump its major for a change nobody can trip on.
//
// Deliberately shallow: only the top level is compared, so an optional property added INSIDE a
// nested object still reads as breaking — over-reporting is the safe side of a contract check.

import { canonicalJson } from '@ultimat3/core';
import type { ManifestChange } from './diff-change';

type JsonObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const names = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** True when `after` accepts every payload `before` does, by only adding optional properties. */
export function onlyAddsOptionalProperties(before: unknown, after: unknown): boolean {
  if (!isObject(before) || !isObject(after)) return false;
  const beforeProps = before['properties'];
  const afterProps = after['properties'];
  if (!isObject(beforeProps) || !isObject(afterProps)) return false;
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
