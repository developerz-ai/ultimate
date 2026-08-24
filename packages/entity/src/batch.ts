// Single responsibility: what `inBatches(size)` hands back — the keyset iteration a `for await`
// consumes, one page per statement, holding its own position and closed by the loop that reads it.
//
// Not a second read path. Every batch is the `findMany` the chain would have sent at that
// position, so filters, tenancy, soft delete, the projection and every `preload()` mean here
// exactly what they mean in `page()`. What this file owns is the loop, the refusals that belong on
// the chain rather than one batch later, and what closing means.

import { assertSeekable } from './cursor';
import type { EntityCore } from './entity';
import { EntityError } from './errors';
import { MAX_PAGE_SIZE, totalOrder } from './plan';
import type { Page } from './repo';
import type { SortKey } from './tenancy';

/**
 * A batch size is rows, whole, at least one and at most `MAX_PAGE_SIZE`. `0`, a fraction and a
 * `NaN` from a parsed environment variable all reach the same statement — `limit 0` reads nothing
 * forever — so they are refused where they were written instead of hanging a job. The ceiling is
 * the top of the same range: a batch IS a page (`inBatches` sends the `findMany` the chain would
 * have sent), so `planFor` would refuse it one statement in, in `limit()`'s voice, for an author
 * who never wrote a `limit()`.
 */
const badBatchSize = (entityName: string, size: number): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entityName}.inBatches(${String(size)}) — a batch is a whole number of rows, at least one and at most ${MAX_PAGE_SIZE}`,
    fix: `${entityName}.inBatches(500)   # the rows one statement reads`,
  });

/**
 * `limit()` bounds one page; `inBatches()` reads every page. A chain saying both has written one
 * number with two meanings, and neither reading is safe to guess: honouring the limit reads a
 * fraction of a batch, dropping it reads the whole table the caller thought they had bounded.
 */
const limitedBatches = (entityName: string, limit: number, size: number): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entityName}.limit(${limit}).inBatches(${size}) — limit() bounds one page, inBatches() reads every page`,
    fix: `${entityName}.inBatches(${limit})   # drop the limit(): the batch size is the page size`,
  });

/**
 * What the chain has to be before a batch of it exists. Every one of these is the author's own
 * text, so all three are refused when `inBatches()` is called rather than one statement in: an
 * iteration that reads half a table and then fails has already done half the work twice.
 */
export const assertBatchable = <Row>(
  entity: EntityCore<Row>,
  size: number,
  chain: { readonly limit: number | undefined; readonly orderBy: readonly SortKey[] },
): void => {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
    throw badBatchSize(entity.$name, size);
  }
  if (chain.limit !== undefined) throw limitedBatches(entity.$name, chain.limit, size);
  // The order the driver will sort by, primary key included: the cursor between two batches is
  // minted from it, and an ordering that cannot carry one fails on the batch *after* the first —
  // where whatever size the caller happened to pass decides whether anyone ever finds out. A
  // nullable column is NOT such an ordering `As of 2026-08-24`; a nullable primary-key column is.
  assertSeekable(entity, totalOrder(entity, chain.orderBy));
};

/** Where the batches come from: the chain's own starting position, and one page of it at a time. */
export interface BatchRead<Row> {
  /** `after(cursor)` on the chain, or `null` for the first batch. */
  readonly from: string | null;
  /** The page this chain reads at `cursor` — relations attached, exactly as `page()` returns it. */
  page(cursor: string | null): Promise<Page<Row>>;
}

/**
 * One iteration, one handle. `for await` consumes it and closes it on the way out — `break`,
 * `return` and a throw all call `return()` on the iterator, which is what stops the next statement
 * from going out; `await using` is the same guarantee for a handle kept in a variable. It is its
 * own iterator, so a second `for await` continues where the first stopped instead of re-reading
 * the table from the top.
 */
export interface BatchIterator<Row> extends AsyncIterable<readonly Row[]>, AsyncDisposable {
  /**
   * Where the next batch starts, `null` once there is no next one. Persist it and
   * `.after(cursor).inBatches(size)` resumes the iteration — which is what makes stopping early
   * cheap rather than wasted.
   */
  readonly cursor: string | null;
  /** Ends the iteration. Idempotent, and what `await using` calls. */
  close(): Promise<void>;
}

/**
 * The loop itself. Keyset, never OFFSET: each batch resumes from the cursor the previous one ended
 * on, so a row inserted or deleted mid-iteration cannot make the loop skip or repeat one — the
 * whole reason this package has no `offset`.
 */
export const batchIterator = <Row>(read: BatchRead<Row>): BatchIterator<Row> => {
  let cursor = read.from;

  async function* batches(): AsyncGenerator<readonly Row[], void, undefined> {
    do {
      const page = await read.page(cursor);
      // Advanced before the yield, so a consumer that breaks reads `.cursor` as the position it
      // stopped at rather than the one it just consumed.
      cursor = page.nextCursor;
      // Never an empty batch: a consumer forced to check `batch.length` is reading around the
      // iterator instead of through it. The last page ends the loop by its cursor, not by
      // yielding nothing.
      if (page.rows.length > 0) yield page.rows;
    } while (cursor !== null);
  }

  // Created once and never restarted: the generator's own state is what "closed" means, so
  // `close()` is idempotent by construction rather than by a flag two paths could disagree about.
  const iterator = batches();
  const close = async (): Promise<void> => {
    await iterator.return(undefined);
  };

  return {
    get cursor(): string | null {
      return cursor;
    },
    [Symbol.asyncIterator]: () => iterator,
    close,
    [Symbol.asyncDispose]: close,
  };
};
