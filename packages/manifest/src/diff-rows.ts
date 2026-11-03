// A read's declared row in a contract diff, member by member. Never `canonicalJson` inequality as
// for an action's output (`diff-operations.ts`): an entity gaining a column would flip every
// `rows: X.$schema` read to breaking. The axis is what a client decoding the row can no longer rely
// on. A schema this cannot walk (a union, an enum) compares whole: over-reporting is the safe side.

import { canonicalJson, isJsonObject } from '@ultimat3/core';
import type { ManifestChange } from './diff-change';

/** Prose for a reader: what no decoder acts on, so it can never be a contract change. */
const ANNOTATIONS = new Set(['title', 'description']);
/** Everything but prose and the keys walked below has to match whole. */
const NOT_WHOLE = new Set([...ANNOTATIONS, 'properties', 'required', 'items']);

const whole = (schema: object): Readonly<Record<string, unknown>> =>
  Object.fromEntries(Object.entries(schema).filter(([key]) => !NOT_WHOLE.has(key)));

const requiredOf = (schema: Readonly<Record<string, unknown>>): ReadonlySet<string> => {
  const required = schema['required'];
  return new Set(
    Array.isArray(required)
      ? required.filter((item): item is string => typeof item === 'string')
      : [],
  );
};

const same = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

const retyped = (path: string): ManifestChange => ({
  kind: 'breaking',
  path,
  detail: 'row member retyped',
});

/** The change between two row schemas at `path`: `queries.<name>.rows`, then one per member. */
export function diffRows(path: string, before: unknown, after: unknown): readonly ManifestChange[] {
  if (same(before, after)) return [];
  if (!isJsonObject(before) || !isJsonObject(after)) return [retyped(path)];
  if (!same(whole(before), whole(after))) return [retyped(path)];
  const changes: ManifestChange[] = [];
  if (!sameAnnotations(before, after)) {
    changes.push({ kind: 'internal', path, detail: 'row description changed' });
  }
  changes.push(...diffItems(path, before['items'], after['items']));
  const members = before['properties'];
  const nextMembers = after['properties'];
  if (isJsonObject(members) && isJsonObject(nextMembers)) {
    changes.push(...diffMembers(path, before, after, members, nextMembers));
  } else if (!same(members, nextMembers)) {
    changes.push(retyped(path));
  }
  return changes;
}

function sameAnnotations(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): boolean {
  return [...ANNOTATIONS].every((key) => same(before[key] ?? null, after[key] ?? null));
}

function diffItems(path: string, before: unknown, after: unknown): readonly ManifestChange[] {
  if (before === undefined && after === undefined) return [];
  if (before === undefined || after === undefined) return [retyped(path)];
  return diffRows(`${path}[]`, before, after);
}

function diffMembers(
  path: string,
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  members: Readonly<Record<string, unknown>>,
  nextMembers: Readonly<Record<string, unknown>>,
): readonly ManifestChange[] {
  const changes: ManifestChange[] = [];
  const required = requiredOf(before);
  const nextRequired = requiredOf(after);
  for (const [name, schema] of Object.entries(members)) {
    const memberPath = `${path}.${name}`;
    if (!Object.hasOwn(nextMembers, name)) {
      changes.push({ kind: 'breaking', path: memberPath, detail: 'row member removed' });
      continue;
    }
    changes.push(...diffRows(memberPath, schema, nextMembers[name]));
    if (required.has(name) && !nextRequired.has(name)) {
      changes.push({ kind: 'breaking', path: memberPath, detail: 'row member no longer required' });
    } else if (!required.has(name) && nextRequired.has(name)) {
      changes.push({ kind: 'additive', path: memberPath, detail: 'row member now required' });
    }
  }
  for (const name of Object.keys(nextMembers)) {
    if (!Object.hasOwn(members, name)) {
      changes.push({ kind: 'additive', path: `${path}.${name}`, detail: 'row member added' });
    }
  }
  return changes;
}
