/**
 * What `live: true` actually produces: the descriptor @ultimat3/realtime
 * subscribes to. It carries the SQL shape (for the matcher), the dependency set
 * (which entities/tags a change feed must touch to matter), the policy (re-run
 * per subscriber, never once for a channel) and a cursor for cheap reconnects.
 */
import type { Ctx } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { Patch } from './matcher';
import { assertMatchable } from './matcher';
import type { QueryPolicy, QuerySubject } from './policy-gate';
import { guard } from './policy-gate';
import type { Query } from './query';
import { queryHash } from './query';
import { queryName, sourceFor } from './read';
import type { QueryShape, SeekKey } from './shape';
import { seekKeyOf } from './shape';
import { tagKeys } from './tags';

/**
 * Reconnect state. Deliberately tiny — an id, a sort key and a version — because
 * the reconnect path is this framework's biggest identified risk.
 *
 * Tradeoff: a cursor is not a snapshot. Resuming re-runs the *bounded* query
 * (`limit` rows from the sort key onward) instead of replaying a change log, so
 * the server keeps no per-subscriber history and reconnect costs one indexed
 * keyset read. The price: changes to rows the client holds but that sort *before*
 * the cursor cannot be detected from the cursor alone, so any epoch change —
 * new build, policy change, schema change — forces a full refetch rather than a
 * resume. We buy bounded server memory with an occasional full page fetch.
 */
export interface LiveCursor {
  /** Build/policy generation. A mismatch means refetch, never resume. */
  readonly epoch: string;
  readonly queryHash: string;
  /** Monotonic per subscription; bumps once per applied patch batch. */
  readonly version: number;
  /** Sort-key values of the last row the client holds, plus its id tiebreak. */
  readonly seek: SeekKey | null;
  readonly rows: number;
}

export type ResumeMode = 'resume' | 'refetch';

export interface ResumePlan {
  readonly mode: ResumeMode;
  readonly reason: string;
  /** Present when `mode === 'resume'`: where the bounded re-read starts. */
  readonly seek: SeekKey | null;
}

export interface LiveQuery {
  readonly name: string;
  readonly queryHash: string;
  readonly shape: QueryShape;
  /** Entities and cache tags this read depends on — the change-feed filter. */
  readonly reads: readonly string[];
  readonly policy: QueryPolicy;
  readonly sqlText: string;
  readonly limit: number | null;
  /** Per-subscriber authorization. Called on subscribe *and* on every fanout. */
  authorize(subject: QuerySubject): Promise<void>;
  initialCursor(rows: readonly object[]): LiveCursor;
  /** `tail` is the last row of the window after the patches applied, if any. */
  advance(cursor: LiveCursor, patches: readonly Patch<object>[], tail?: object): LiveCursor;
  resume(cursor: LiveCursor): ResumePlan;
}

export interface ToLiveOptions {
  readonly ctx?: Ctx;
  /** Overrides the process epoch. Tests pin it; the server derives it from the build. */
  readonly epoch?: string;
}

/** Changing the build changes the epoch, which forces reconnects to refetch. */
export function liveEpoch(): string {
  return Bun.env['X_BUILD_ID'] ?? 'dev';
}

export async function toLiveQuery<TInput extends StandardSchemaV1, TRow extends object>(
  target: Query<TInput, TRow>,
  input: unknown,
  options: ToLiveOptions = {},
): Promise<LiveQuery> {
  const name = queryName(target);
  const source = await sourceFor(target, input, {
    ...(options.ctx === undefined ? {} : { ctx: options.ctx }),
    surface: 'live',
  });
  const shape = source.shape();
  // Fail at subscribe time, not on the first change event nobody can patch.
  assertMatchable(name, shape);

  const epoch = options.epoch ?? liveEpoch();
  const hash = queryHash(name, input);
  const reads = [...new Set([shape.entity, ...tagKeys(target.cache?.tags ?? [])])].sort();
  // The query's own policy object, not a copy: the same authz a direct read runs.
  const policy = target.policy;

  return {
    name,
    queryHash: hash,
    shape,
    reads,
    policy,
    sqlText: source.toSQL().sql,
    limit: shape.limit,
    authorize: async (subject) => {
      guard(policy, subject, 'live');
    },
    initialCursor: (rows) => ({
      epoch,
      queryHash: hash,
      version: 0,
      seek: seekOf(rows[rows.length - 1], shape),
      rows: rows.length,
    }),
    advance: (cursor, patches, tail) => advanceCursor(cursor, patches, shape, tail),
    resume: (cursor) => planResume(cursor, epoch, hash),
  };
}

/** Cursor arithmetic kept pure so the sync node can replay it deterministically. */
export function advanceCursor(
  cursor: LiveCursor,
  patches: readonly Patch<object>[],
  shape: QueryShape,
  tail?: object,
): LiveCursor {
  let rows = cursor.rows;
  for (const patch of patches) {
    if (patch.kind === 'add') rows += 1;
    if (patch.kind === 'remove') rows = Math.max(0, rows - 1);
  }
  const seek = tail === undefined ? cursor.seek : seekOf(tail, shape);
  return { ...cursor, version: cursor.version + 1, rows, seek };
}

export function planResume(cursor: LiveCursor, epoch: string, hash: string): ResumePlan {
  if (cursor.epoch !== epoch) {
    return { mode: 'refetch', reason: 'epoch changed (new build, policy or schema)', seek: null };
  }
  if (cursor.queryHash !== hash) {
    return { mode: 'refetch', reason: 'query arguments changed', seek: null };
  }
  if (cursor.seek === null) {
    return { mode: 'refetch', reason: 'no sort key held', seek: null };
  }
  return { mode: 'resume', reason: 'bounded keyset re-read', seek: cursor.seek };
}

/** The sort-key values of a row under the query's ordering, id as the tiebreak. */
export function seekOf(row: object | undefined, shape: QueryShape): SeekKey | null {
  return row === undefined ? null : seekKeyOf(row, shape);
}
