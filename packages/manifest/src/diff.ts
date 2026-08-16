// `diffManifest` — the contract diff `x verify` gates on.
//
// Three classes, and the classification is the whole value:
//   breaking  — an existing consumer stops working (a removal, a tightened input, a changed
//               output, a new or changed policy, a newly REQUIRED permission, a tightened rate
//               limit — anything that already shipped and now refuses a caller it served)
//   additive  — a new capability; nothing that worked stops working
//   internal  — visible in the file but not in the contract (a description, a cache tag, the
//               buildId itself)
// `x verify` fails on a breaking change without a major version bump. Additive and internal
// changes never fail, which is what makes the gate credible enough to leave on.

import { isMcpExposed } from '@ultimat3/core';
import { canonical } from './build';
import type { ActionFact, JobFact, Manifest, QueryFact, RateLimitFact, RouteFact } from './schema';

export type ChangeKind = 'breaking' | 'additive' | 'internal';

export interface ManifestChange {
  readonly kind: ChangeKind;
  /** Dotted path into the manifest, e.g. `actions.publishPost.policy`. */
  readonly path: string;
  readonly detail: string;
}

export interface ManifestDiff {
  readonly changes: readonly ManifestChange[];
  readonly breaking: readonly ManifestChange[];
  readonly additive: readonly ManifestChange[];
  readonly internal: readonly ManifestChange[];
  readonly hasBreaking: boolean;
}

export function diffManifest(before: Manifest, after: Manifest): ManifestDiff {
  const changes: ManifestChange[] = [];

  if (before.manifestVersion !== after.manifestVersion) {
    changes.push({
      kind: 'breaking',
      path: 'manifestVersion',
      detail: `manifest shape ${before.manifestVersion} -> ${after.manifestVersion}`,
    });
  }
  if (before.buildId !== after.buildId) {
    changes.push({ kind: 'internal', path: 'buildId', detail: 'content changed' });
  }

  changes.push(...diffActions(before.actions, after.actions));
  changes.push(...diffQueries(before.queries, after.queries));
  changes.push(...diffRoutes(before.routes, after.routes));
  changes.push(...diffJobs(before.jobs, after.jobs));
  changes.push(...diffEntities(before, after));
  changes.push(...diffNamedSet('permissions', before.permissions, after.permissions));
  changes.push(...diffNamedSet('locales', before.locales, after.locales, 'additive'));

  const sorted = [...changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const breaking = sorted.filter((c) => c.kind === 'breaking');
  return {
    changes: sorted,
    breaking,
    additive: sorted.filter((c) => c.kind === 'additive'),
    internal: sorted.filter((c) => c.kind === 'internal'),
    hasBreaking: breaking.length > 0,
  };
}

function diffActions(
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
    if (canonical(action.input) !== canonical(next.input)) {
      changes.push({ kind: 'breaking', path: `${path}.input`, detail: 'input schema changed' });
    }
    if (canonical(action.output) !== canonical(next.output)) {
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
    if (canonical(action.cacheInvalidates) !== canonical(next.cacheInvalidates)) {
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

function diffQueries(
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
    if (canonical(query.input) !== canonical(next.input)) {
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

/** No declaration at all, a declaration, or one this reader cannot make sense of. */
type RateLimitReading = RateLimitFact | 'none' | 'unreadable';

/**
 * A tightened limit refuses a caller the old pair served, which is the definition of breaking —
 * and it is the one contract change that leaves every schema in the manifest untouched, so
 * nothing else here can see it. Introducing a limit where there was none is the same event at
 * its extreme: a client that was never throttled now can be.
 */
function diffRateLimit(
  path: string,
  before: ActionFact,
  after: ActionFact,
): readonly ManifestChange[] {
  const declared = readRateLimit(before);
  const next = readRateLimit(after);
  if (declared === 'unreadable' || next === 'unreadable') return [];
  const at = `${path}.rateLimit`;

  if (declared === 'none') {
    if (next === 'none') return [];
    return [
      {
        kind: 'breaking',
        path: at,
        detail: `rate limit introduced (${render(next)}); an unthrottled caller can now be refused`,
      },
    ];
  }
  if (next === 'none') {
    return [{ kind: 'additive', path: at, detail: `rate limit removed (was ${render(declared)})` }];
  }
  if (tighter(declared, next)) {
    return [
      {
        kind: 'breaking',
        path: at,
        detail: `rate limit tightened ${render(declared)} -> ${render(next)}; callers at the old rate are refused`,
      },
    ];
  }
  if (tighter(next, declared)) {
    return [
      {
        kind: 'additive',
        path: at,
        detail: `rate limit loosened ${render(declared)} -> ${render(next)}`,
      },
    ];
  }
  return [];
}

/**
 * Both halves, because either one alone refuses somebody: `limit` is the burst a caller may
 * spend at once and `limit / windowMs` is the rate it refills at, so a larger burst on a slower
 * refill still turns away a client the old pair served. Cross-multiplied rather than divided —
 * both windows are positive, and an exact integer comparison cannot invent a change out of a
 * rounding difference in a file that is diffed on every build.
 */
const tighter = (from: RateLimitFact, to: RateLimitFact): boolean =>
  to.limit < from.limit || to.limit * from.windowMs < from.limit * to.windowMs;

const render = (limit: RateLimitFact): string => `${limit.limit}/${limit.windowMs}ms`;

function readRateLimit(fact: ActionFact): RateLimitReading {
  const value: unknown = fact.rateLimit;
  if (value === undefined || value === null) return 'none';
  if (typeof value !== 'object') return 'unreadable';
  const record = value as Record<string, unknown>;
  const limit = record['limit'];
  const windowMs = record['windowMs'];
  // The same two conditions `toBucket` enforces at mount: a non-positive window is an infinite
  // refill and a sub-token limit closes the endpoint, so neither describes a limit to compare.
  if (!positive(limit) || !positive(windowMs)) return 'unreadable';
  return { limit, windowMs };
}

const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

function diffRoutes(
  before: readonly RouteFact[],
  after: readonly RouteFact[],
): readonly ManifestChange[] {
  const changes: ManifestChange[] = [];
  const afterByUrl = index(after, (r) => r.url);
  const beforeByUrl = index(before, (r) => r.url);

  for (const route of before) {
    const next = afterByUrl.get(route.url);
    if (next === undefined) {
      // A removed URL is a 404 for anyone holding a link to it.
      changes.push({ kind: 'breaking', path: `routes.${route.url}`, detail: 'route removed' });
      continue;
    }
    if (route.render !== next.render) {
      changes.push({
        kind: 'internal',
        path: `routes.${route.url}.render`,
        detail: `render ${route.render} -> ${next.render}`,
      });
    }
  }
  for (const route of after) {
    if (!beforeByUrl.has(route.url)) {
      changes.push({ kind: 'additive', path: `routes.${route.url}`, detail: 'route added' });
    }
  }
  return changes;
}

function diffJobs(
  before: readonly JobFact[],
  after: readonly JobFact[],
): readonly ManifestChange[] {
  const changes: ManifestChange[] = [];
  const afterByName = index(after, (j) => j.name);
  const beforeByName = index(before, (j) => j.name);

  for (const job of before) {
    const next = afterByName.get(job.name);
    if (next === undefined) {
      // Enqueued-but-undeliverable work is silent data loss, so a removal is breaking.
      changes.push({ kind: 'breaking', path: `jobs.${job.name}`, detail: 'job removed' });
      continue;
    }
    if (canonical(job.input) !== canonical(next.input)) {
      changes.push({
        kind: 'breaking',
        path: `jobs.${job.name}.input`,
        detail: 'input schema changed; in-flight payloads will not parse',
      });
    }
    if (canonical(job.steps) !== canonical(next.steps)) {
      changes.push({
        kind: 'internal',
        path: `jobs.${job.name}.steps`,
        detail: 'steps changed; resumed runs may replay differently',
      });
    }
  }
  for (const job of after) {
    if (!beforeByName.has(job.name)) {
      changes.push({ kind: 'additive', path: `jobs.${job.name}`, detail: 'job added' });
    }
  }
  return changes;
}

function diffEntities(before: Manifest, after: Manifest): readonly ManifestChange[] {
  const changes: ManifestChange[] = [];
  const afterByName = index(after.entities, (e) => e.name);
  const beforeByName = index(before.entities, (e) => e.name);

  for (const entity of before.entities) {
    const next = afterByName.get(entity.name);
    if (next === undefined) {
      changes.push({ kind: 'breaking', path: `entities.${entity.name}`, detail: 'entity removed' });
      continue;
    }
    const nextColumns = index(next.columns, (c) => c.name);
    for (const column of entity.columns) {
      const nextColumn = nextColumns.get(column.name);
      const path = `entities.${entity.name}.columns.${column.name}`;
      if (nextColumn === undefined) {
        changes.push({ kind: 'breaking', path, detail: 'column removed' });
        continue;
      }
      if (column.type !== nextColumn.type) {
        changes.push({
          kind: 'breaking',
          path: `${path}.type`,
          detail: `${column.type} -> ${nextColumn.type}`,
        });
      }
      if (column.nullable && !nextColumn.nullable) {
        // Tightening nullability rejects rows that were valid a moment ago.
        changes.push({ kind: 'breaking', path: `${path}.nullable`, detail: 'became NOT NULL' });
      }
    }
    const beforeColumns = index(entity.columns, (c) => c.name);
    for (const column of next.columns) {
      if (!beforeColumns.has(column.name)) {
        changes.push({
          kind: column.nullable ? 'additive' : 'breaking',
          path: `entities.${entity.name}.columns.${column.name}`,
          detail: column.nullable ? 'column added' : 'NOT NULL column added with no default',
        });
      }
    }
  }
  for (const entity of after.entities) {
    if (!beforeByName.has(entity.name)) {
      changes.push({ kind: 'additive', path: `entities.${entity.name}`, detail: 'entity added' });
    }
  }
  return changes;
}

function diffNamedSet(
  path: string,
  before: readonly string[],
  after: readonly string[],
  removalKind: ChangeKind = 'breaking',
): readonly ManifestChange[] {
  const changes: ManifestChange[] = [];
  const afterSet = new Set(after);
  const beforeSet = new Set(before);
  for (const name of before) {
    if (!afterSet.has(name)) {
      changes.push({ kind: removalKind, path: `${path}.${name}`, detail: 'removed' });
    }
  }
  for (const name of after) {
    if (!beforeSet.has(name)) {
      changes.push({ kind: 'additive', path: `${path}.${name}`, detail: 'added' });
    }
  }
  return changes;
}

function index<T>(items: readonly T[], key: (item: T) => string): Map<string, T> {
  return new Map(items.map((item) => [key(item), item]));
}

/** One line per change, `--json`-free, for a terminal summary. */
export function formatDiff(diff: ManifestDiff): readonly string[] {
  return diff.changes.map((c) => `${c.kind.padEnd(8)} ${c.path}: ${c.detail}`);
}
