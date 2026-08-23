/**
 * `postExcerpts`: one pass filling the excerpt of every post that has none. `backfill()` is a job
 * factory, not a ninth primitive, so this inherits `.enqueue()`, the retry policy, the worker's
 * cancellation, the dead-letter path, `x jobs show` and a manifest row without a line here.
 *
 * `BackfillBatch` comes from @ultimat3/jobs, not @ultimat3/schema: a backfill file imports one
 * package.
 */

import { db, type Post } from '@postly/db';
import { excerptOf } from '@postly/domain';
import { assert, type Ctx, hasScope } from '@ultimat3/core';
import { CROSS_TENANT_SCOPE, type ReadBuilder } from '@ultimat3/entity';
import { type BackfillBatch, backfill } from '@ultimat3/jobs';

/**
 * The rows this pass visits: posts whose excerpt is still blank, and only those. Narrowing
 * `source` to the rows that are actually behind is what lets `count` below converge — a source
 * matching every row would re-normalise for ever and could never answer "how many are left".
 *
 * A sweep over the whole table belongs to no one org, so the declaration is `tenant: 'none'` —
 * which STRIPS the org from the run rather than inheriting the worker's, and `backfillPass` opens
 * `crossTenant` around it. That makes spanning tenants a capability instead of an accident: the
 * actor this worker runs as has to carry `tenancy:cross`, and this is where that is said, before
 * a page is read. The per-org shape is the other one — `tenant: () => orgId`, one enqueue per org,
 * and `.where({ orgId })` back on the chain.
 */
const behind = (ctx: Ctx): ReadBuilder<Post> => {
  assert(
    hasScope(ctx.actor, CROSS_TENANT_SCOPE),
    'post-excerpts: this pass spans every tenant and its actor holds no tenancy:cross',
    'x db backfill post-excerpts --write --json',
  );
  return db.posts.andWhere('excerpt', 'eq', '');
};

/**
 * What the sweep writes for one row, exported so the test asserts the WORK and not only the
 * declaration around it. `excerptOf` is `@postly/domain`'s one deterministic excerpt — the same
 * function `createDraft` calls — so this pass can never disagree with a fresh write.
 *
 * IDEMPOTENT by construction, which is the contract that matters: a page replays whole when an
 * attempt is cancelled between its last row and its checkpoint, so the second run must produce the
 * first run's row. `excerptOf(body)` of an already-filled row is the value already there, and a
 * row that arrived non-blank is returned untouched — never `excerpt + more`, never `count + 1`.
 */
export const withExcerpt = (row: Post): Post =>
  row.excerpt === '' ? { ...row, excerpt: excerptOf(row.body) } : row;

export const postExcerpts = backfill({
  name: 'post-excerpts',
  tenant: 'none',
  source: ({ ctx }): ReadBuilder<Post> => behind(ctx),
  handle: async ({ rows, signal }: BackfillBatch<Post>) => {
    // One page, in its own durable step, at least once. The signal is the run's cancellation
    // composed with this batch's ceiling, so a cancelled pass stops here rather than writing past
    // its lease — and past it `step.run` refuses the write anyway.
    signal.throwIfAborted();
    // One statement for the page, not one per row: `upsertAll` is the bulk write a per-row
    // `update` loop is the N+1 of, and `onConflict: ['id']` makes a replayed page a no-op rewrite
    // of the same values rather than a second insert.
    await db.posts.upsertAll(rows.map(withExcerpt), { onConflict: ['id'] });
  },
  /**
   * How many rows still NEED the change — never how many the pass visits. It is the same predicate
   * `source` selects on, counted rather than read, which is what makes a dry run unable to lie: a
   * pass that exhausts its source while this still answers above zero has two predicates that
   * disagree, and that is `X_BACKFILL_STALLED` rather than a completed row nobody can trust.
   */
  count: ({ ctx }) => behind(ctx).count(),
  // A sweep shares its pool with the requests the app is still serving, so the default rate is
  // slow on purpose and there is no unthrottled mode. Defaults left in place here:
  // batch: 1_000, // rows per statement and per step
  // rate: 5,      // batches per second
  // requires: '20260814120000_add_publish_at', // the migration `x db backfill` checks first
  // environments: ['staging', 'production'],   // omit for every environment — never implied
});
