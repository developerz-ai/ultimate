// `backfill()` — one pass over every row a chain matches, declared as a `job` and NOT as a ninth
// primitive. A backfill is durable background work with an input schema, a retry policy, an
// idempotency key and a queue, which is the definition of a `job` — so this file is a FACTORY over
// `job()`, exactly as `llm()` is one over `action()`. That is what gives a backfill `.enqueue()`,
// the worker's cancellation, the dead-letter path, `x jobs show` and a manifest row without a line
// here, and it is why nothing in the framework grows a ninth kind of thing to hold table sweeps.
//
// The declaration lives here and the pass lives in `backfill-pass.ts` — the same split `job.ts`
// and `execute.ts` already have, and the reason the iteration, the checkpoints and the
// `x_backfills` ledger are one file's problem rather than this one's.

import { assert } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import type {
  BackfillDefinition,
  BackfillInput,
  ScopedBackfillDefinition,
  ScopedBackfillInput,
} from './backfill-definition';
import { backfillChecksum } from './backfill-ledger';
import { backfillPass } from './backfill-pass';
import { backfillPacer, DEFAULT_BACKFILL_RATE } from './backfill-rate';
import type { BackfillCount } from './backfill-registry';
import { stampBackfill } from './backfill-registry';
import type { AnyBackfill } from './backfill-source';
import { assertBackfillSource, ledgerNameFor, scopedPayload } from './backfill-source';
import type { JobHandle } from './job';
import { job } from './job';
import { DEFAULT_RETRY } from './retry';
import type { JobTenant } from './tenant';

/**
 * Rows per statement and per durable step. Not `entity`'s `DEFAULT_PAGE_SIZE`: that number is a
 * page somebody scrolls, and a backfill of a million rows at 50 writes twenty thousand step rows
 * to move the same data. One statement's worth of work that a worker can still finish inside a
 * lease is the size that belongs here.
 */
export const DEFAULT_BACKFILL_BATCH = 1_000;

export type {
  BackfillBatch,
  BackfillDefinition,
  BackfillInput,
  BackfillPage,
  BackfillPages,
  BackfillReport,
  ScopedBackfillDefinition,
  ScopedBackfillInput,
} from './backfill-definition';

export function backfill<Row>(definition: BackfillDefinition<Row>): JobHandle<BackfillInput>;
export function backfill<Row, I>(
  definition: ScopedBackfillDefinition<Row, I>,
): JobHandle<ScopedBackfillInput<I>>;
export function backfill<Row, I>(
  definition: BackfillDefinition<Row> | ScopedBackfillDefinition<Row, I>,
): JobHandle<BackfillInput> | JobHandle<ScopedBackfillInput<I>> {
  // Before anything is registered under the name, so the corrected declaration still can be.
  assertBackfillSource(definition);
  const size = definition.batch ?? DEFAULT_BACKFILL_BATCH;
  // Refused where it was written. `inBatches()` refuses the same number one statement in, which
  // for a backfill means a dead-lettered job and a stack trace instead of a failing build.
  assert(
    Number.isSafeInteger(size) && size >= 1,
    `backfill "${definition.name}" declares batch: ${String(size)} — a batch is a whole number of rows, at least one`,
    `set batch: ${DEFAULT_BACKFILL_BATCH} on backfill("${definition.name}") — the rows one statement reads and one durable step handles`,
  );
  const rate = definition.rate ?? DEFAULT_BACKFILL_RATE;
  // Refused in the same voice and for the same reason as `batch` above — except that an unpaced
  // sweep is not a dead-lettered job but a saturated pool, which the app finds out about first.
  assert(
    Number.isFinite(rate) && rate > 0,
    `backfill "${definition.name}" declares rate: ${String(rate)} — a rate is batches per second, greater than zero`,
    `set rate: ${DEFAULT_BACKFILL_RATE} on backfill("${definition.name}"), or leave it out — to sweep faster raise the number, there is no unthrottled mode`,
  );
  // Hashed once, at declaration: the definition cannot change while the process runs, and a hash
  // per attempt would charge every batch of every pass for a fact that is fixed at import.
  // `rate` is NOT in it, for the reason `batch` is not: pacing is a tuning knob, and changing one
  // does not make a completed sweep a different sweep.
  // `pages` is hashed where `source` would be: either is "which rows this pass visits".
  const checksum = backfillChecksum(definition.pages ?? definition.source, definition.handle);
  // Built here rather than per attempt: the interval belongs to the table and the pool, not to
  // whichever attempt holds the run, so a retrying pass keeps the pace it was declared with.
  const pace = backfillPacer({ rate, job: definition.name });

  // Bound to the definition rather than passed bare: `count` is declared as a method, so a
  // reference torn off the object literal would run with `this` undefined the first time an
  // author writes `count: ({ ctx }) => this.something`.
  // A scoped count needs the scope's input, which `x db backfill` has none of: not stamped.
  const declaredCount = definition.scope === undefined ? definition.count : undefined;
  const count: BackfillCount | undefined =
    declaredCount === undefined
      ? undefined
      : ({ ctx }) =>
          (declaredCount as NonNullable<AnyBackfill<Row>['count']>).call(definition, {
            ctx,
            input: undefined,
          });

  const scope = definition.scope;
  const handle = job<BackfillInput & { readonly input?: unknown }>({
    name: definition.name,
    // Unscoped: byte-identical to before scopes existed. Scoped: the force flag and the input.
    input:
      scope === undefined
        ? t.object({ force: t.boolean.optional() })
        : scopedPayload(definition.name, definition.input),
    // One live run per name — per scope for a scoped one — forced or not. A second enqueue while
    // the pass is still going is the same pass, and deduping it is what makes "kick it again" safe
    // rather than a second writer on one table — which a `force` in the key would have allowed.
    idempotencyKey: (payload) => ledgerNameFor(definition.name, scope, payload),
    // Forwarded verbatim, like every other job field this factory carries: a backfill that
    // declared its tenant and then ran under somebody else's would be a factory deciding authz.
    tenant: definition.tenant as JobTenant<BackfillInput & { readonly input?: unknown }>,
    retry: definition.retry ?? DEFAULT_RETRY,
    ...(definition.queue === undefined ? {} : { queue: definition.queue }),
    ...(definition.timeout === undefined ? {} : { timeout: definition.timeout }),
    run: (args) =>
      backfillPass({ definition: definition as AnyBackfill<Row>, size, checksum, pace }, args),
  });
  // Stamped, never registered by the app: this is what makes a declared-but-never-enqueued sweep
  // visible to `x db backfill --pending`, and the `origin` WeakMap is `task.ts`'s mechanism rather
  // than a second one. `job()` above already refused a duplicate name, so this cannot overwrite.
  stampBackfill(handle, {
    checksum,
    scoped: scope !== undefined,
    requires: definition.requires,
    environments: definition.environments,
    count,
  });
  return handle as JobHandle<BackfillInput>;
}
