// The two callable surfaces — actions and queries — and the permissions they require.

import { canonicalJson, isMcpExposed } from '@ultimat3/core';
import type { ManifestChange } from './diff-change';
import { index } from './diff-change';
import { diffRateLimit } from './diff-rate-limit';
import type { ActionFact, QueryFact } from './schema';

export function diffActions(
  before: readonly ActionFact[],
  after: readonly ActionFact[],
): readonly ManifestChange[] {
  const changes: ManifestChange[] = [];
  const afterByName = index(after, (a) => a.name);
  const beforeByName = index(before, (a) => a.name);

  for (const action of before) {
    const next = afterByName.get(action.name);
    const path = `actions.${action.name}`;
    if (next === undefined) {
      // The canonical breaking change: a caller that compiled yesterday no longer does.
      changes.push({ kind: 'breaking', path, detail: 'action removed' });
      continue;
    }
    if (canonicalJson(action.input) !== canonicalJson(next.input)) {
      changes.push({ kind: 'breaking', path: `${path}.input`, detail: 'input schema changed' });
    }
    if (canonicalJson(action.output) !== canonicalJson(next.output)) {
      changes.push({ kind: 'breaking', path: `${path}.output`, detail: 'output schema changed' });
    }
    if (action.policy !== next.policy) {
      changes.push({
        kind: 'breaking',
        path: `${path}.policy`,
        detail: `policy ${action.policy ?? 'none'} -> ${next.policy ?? 'none'}`,
      });
    }
    // Through `isMcpExposed`, not the raw field: `before` is a file parsed from disk, so an
    // older or hand-trimmed manifest can carry an absent, `null` or non-boolean `expose` that
    // `!==` would read as a change and classify from. One predicate, the same one the tool
    // projection asks, is what makes this verdict match what the surface actually serves.
    const exposed = isMcpExposed(action.mcp);
    const nextExposed = isMcpExposed(next.mcp);
    if (exposed !== nextExposed) {
      // Widening the surface is additive; withdrawing a tool an agent depends on is not.
      changes.push({
        kind: nextExposed ? 'additive' : 'breaking',
        path: `${path}.mcp.expose`,
        detail: `mcp exposure ${String(exposed)} -> ${String(nextExposed)}`,
      });
    }
    changes.push(...diffPermissions(path, action, next));
    changes.push(...diffRateLimit(path, action, next));
    if (canonicalJson(action.cacheInvalidates) !== canonicalJson(next.cacheInvalidates)) {
      changes.push({
        kind: 'internal',
        path: `${path}.cacheInvalidates`,
        detail: 'cache tags changed',
      });
    }
  }
  for (const action of after) {
    if (!beforeByName.has(action.name)) {
      changes.push({ kind: 'additive', path: `actions.${action.name}`, detail: 'action added' });
    }
  }
  return changes;
}

export function diffQueries(
  before: readonly QueryFact[],
  after: readonly QueryFact[],
): readonly ManifestChange[] {
  const changes: ManifestChange[] = [];
  const afterByName = index(after, (q) => q.name);
  const beforeByName = index(before, (q) => q.name);

  for (const query of before) {
    const next = afterByName.get(query.name);
    const path = `queries.${query.name}`;
    if (next === undefined) {
      changes.push({ kind: 'breaking', path, detail: 'query removed' });
      continue;
    }
    if (canonicalJson(query.input) !== canonicalJson(next.input)) {
      changes.push({ kind: 'breaking', path: `${path}.input`, detail: 'input schema changed' });
    }
    if (query.policy !== next.policy) {
      changes.push({
        kind: 'breaking',
        path: `${path}.policy`,
        detail: `policy ${query.policy ?? 'none'} -> ${next.policy ?? 'none'}`,
      });
    }
    changes.push(...diffPermissions(path, query, next));
    if (query.live !== next.live) {
      // Losing live-ness breaks subscribers; gaining it breaks nobody.
      changes.push({
        kind: next.live ? 'additive' : 'breaking',
        path: `${path}.live`,
        detail: `live ${String(query.live)} -> ${String(next.live)}`,
      });
    }
    // The same fact as an action's `cacheInvalidates`, and the same class: which tag flushes a
    // read is not a caller's contract, but a reviewer has to see it move.
    if (canonicalJson(query.cacheTags) !== canonicalJson(next.cacheTags)) {
      changes.push({ kind: 'internal', path: `${path}.cacheTags`, detail: 'cache tags changed' });
    }
  }
  for (const query of after) {
    if (!beforeByName.has(query.name)) {
      changes.push({ kind: 'additive', path: `queries.${query.name}`, detail: 'query added' });
    }
  }
  return changes;
}

/**
 * The permissions an operation REQUIRES, and the direction each move points.
 *
 * Gaining one is breaking: every caller holding yesterday's grant set is refused by an operation
 * that served them, and the failure arrives at runtime as a 403 with nothing in the build that
 * said so. Losing one is additive — nothing that worked stops working — but it is still reported,
 * because a grant quietly dropped from an operation is a widening of access a reviewer has to see.
 *
 * Matched on `permissions`, never `policy`: `policy` is a display label, and a composite's label
 * (`and(post:publish, org:administer)`) equals no permission, so a rule reading it would call
 * every non-trivially-guarded operation unchanged while both of its real grants moved.
 */
function diffPermissions(
  path: string,
  before: ActionFact | QueryFact,
  after: ActionFact | QueryFact,
): readonly ManifestChange[] {
  const declared = readPermissions(before);
  const next = readPermissions(after);
  // Absence is no evidence, on either side. Unlike `mcp.expose` there is no value to fold it
  // into: `[]` asserts "this operation requires nothing", so reading an absent field as `[]`
  // would report every permission of every operation as newly required the first time an app
  // diffs against a manifest written before the field existed — a wall of false breakings for
  // an upgrade that changed no authorization at all.
  if (declared === undefined || next === undefined) return [];

  const changes: ManifestChange[] = [];
  const declaredSet = new Set(declared);
  const nextSet = new Set(next);
  for (const permission of next) {
    if (!declaredSet.has(permission)) {
      changes.push({
        kind: 'breaking',
        path: `${path}.permissions.${permission}`,
        detail: 'now required; callers granted the old set are refused',
      });
    }
  }
  for (const permission of declared) {
    if (!nextSet.has(permission)) {
      changes.push({
        kind: 'additive',
        path: `${path}.permissions.${permission}`,
        detail: 'no longer required; access widened',
      });
    }
  }
  return changes;
}

/** The list as the FILE carries it, or `undefined` when it carries nothing this can compare. */
function readPermissions(fact: ActionFact | QueryFact): readonly string[] | undefined {
  const value: unknown = fact.permissions;
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => typeof entry === 'string')
    ? (value as readonly string[])
    : undefined;
}
