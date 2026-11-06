// `refreshView()` — recompute a materialized view, declared as a `job` and never as a ninth
// primitive. A view over an arbitrary join is refreshed WHOLE; a time window over append-mostly
// rows is `rollup()`'s, which recomputes only recent buckets. The schedule is the app's `task`.

import { db, identifier, sql } from '@ultimat3/db';
import type { EntityCore } from '@ultimat3/entity';
import { t } from '@ultimat3/schema';
import type { DurationInput } from './clock';
import type { JobHandle } from './job';
import { job } from './job';
import { DEFAULT_RETRY, type RetryPolicy } from './retry';
import { RefreshViewInvalidError } from './rollup-errors';

export interface RefreshViewDefinition {
  readonly name: string;
  /** An entity declared `view: { sql, materialized: true }`. */
  readonly view: EntityCore;
  /**
   * `refresh … concurrently`: readers keep the old rows while the new ones are computed, at the
   * price of a unique index on the view (`.unique()` on a column), refused here without one.
   */
  readonly concurrently?: boolean;
  readonly queue?: string;
  readonly retry?: RetryPolicy;
  readonly timeout?: DurationInput;
}

/** What one run reports: the view, and whether readers were blocked while it ran. */
export interface RefreshViewReport {
  readonly view: string;
  readonly concurrently: boolean;
}

const assertRefreshable = (definition: RefreshViewDefinition): boolean => {
  const { name, view } = definition;
  if (view.$viewQuery?.materialized !== true) {
    throw new RefreshViewInvalidError({
      job: name,
      problem: `names ${view.$name}, which is ${view.$viewQuery === null ? 'a table' : 'a plain view, recomputed on every read'} — only a materialized view stores rows to refresh`,
      fix: `entity('${view.$name}', { view: { sql, materialized: true }, columns })   # then x db gen`,
    });
  }
  const concurrently = definition.concurrently === true;
  if (concurrently && !view.$indexes.some((index) => index.unique && index.where === undefined)) {
    throw new RefreshViewInvalidError({
      job: name,
      problem: `refreshes ${view.$name} concurrently, and Postgres needs a unique index on the view to do that`,
      fix: `entity('${view.$name}', { view, columns: { <key>: uuid().unique(), … } })   # or refreshView({ name: '${name}', view, concurrently: false })`,
    });
  }
  return concurrently;
};

export function refreshView(definition: RefreshViewDefinition): JobHandle<Record<string, never>> {
  const concurrently = assertRefreshable(definition);
  const target = identifier(definition.view.$table);
  const statement = concurrently
    ? sql`refresh materialized view concurrently ${target}`
    : sql`refresh materialized view ${target}`;
  return job<Record<string, never>, RefreshViewReport>({
    name: definition.name,
    input: t.object({}),
    // One refresh at a time: a second enqueue while one runs would compute the same rows again.
    idempotencyKey: () => `refresh-view:${definition.name}`,
    // A materialized view spans every tenant's rows; the read path scopes them, not the refresh.
    tenant: 'none',
    retry: definition.retry ?? DEFAULT_RETRY,
    ...(definition.queue === undefined ? {} : { queue: definition.queue }),
    ...(definition.timeout === undefined ? {} : { timeout: definition.timeout }),
    run: ({ step }) =>
      step.run('refresh', async () => {
        await db().execute(statement);
        return { view: definition.view.$name, concurrently };
      }),
  });
}
