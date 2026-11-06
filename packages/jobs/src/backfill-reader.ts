// One page of a backfill, from wherever its rows live: a local chain read through `inBatches()`, or
// the app's remote page function. The pass (`backfill-pass.ts`) asks "the page at this cursor" and
// checkpoints `{ cursor: next, rows: n }`; this file is the only place the two sources differ.

import type { Ctx } from '@ultimat3/core';
import { assert } from '@ultimat3/core';
import type { BatchIterator } from '@ultimat3/entity';
import type { BackfillPage } from './backfill-definition';
import type { AnyBackfill } from './backfill-source';

export interface PageReader<Row> {
  /** The page starting at `cursor`. `next: null` with no rows is an exhausted source. */
  read(cursor: string | null, signal: AbortSignal): Promise<BackfillPage<Row>>;
  close(): Promise<void>;
}

/** One live iteration and the pull that advances it. Rebuilt when the checkpoints disagree. */
interface Iteration<Row> {
  readonly batches: BatchIterator<Row>;
  readonly pull: AsyncIterator<readonly Row[]>;
}

/**
 * A local chain. The iteration is opened on the first page an attempt actually reads, so a resumed
 * pass sends no statement for a page it already handled, and positioned at `cursor`:
 * `batches.cursor` IS where the next statement starts, so comparing it with the checkpoint's is the
 * whole staleness test — `retryFromStep` re-opens ONE step mid-run, which moves the checkpoints
 * somewhere a parked iteration is not.
 */
function sourceReader<Row>(
  source: NonNullable<AnyBackfill<Row>['source']>,
  ctx: Ctx,
  size: number,
): PageReader<Row> {
  let live: Iteration<Row> | undefined;
  return {
    async read(cursor) {
      if (live === undefined || live.batches.cursor !== cursor) {
        await live?.batches.close();
        const opened = source({ ctx }).after(cursor).inBatches(size);
        live = { batches: opened, pull: opened[Symbol.asyncIterator]() };
      }
      const next = await live.pull.next();
      if (next.done === true) return { rows: [], next: null };
      return { rows: next.value, next: live.batches.cursor };
    },
    async close() {
      await live?.batches.close();
    },
  };
}

/**
 * The app's page function. Parsed, not trusted: an absent `next` is not `null`, and a pass that
 * read it as "more" would ask the vendor for page `undefined` forever.
 */
function pagesReader<Row>(
  definition: AnyBackfill<Row>,
  pages: NonNullable<AnyBackfill<Row>['pages']>,
  ctx: Ctx,
  input: unknown,
): PageReader<Row> {
  return {
    async read(cursor, signal) {
      const page = await pages({ ctx, cursor, signal, input });
      const next: unknown = page?.next;
      assert(
        Array.isArray(page?.rows) && (next === null || typeof next === 'string'),
        `backfill "${definition.name}" pages() answered a value that is not { rows: [], next: string | null }`,
        `pages: async ({ cursor }) => ({ rows: page.items, next: page.nextCursor ?? null }) on backfill({ name: "${definition.name}" })`,
      );
      // An empty page that does not move the cursor would be asked for again forever: it ends.
      if (page.rows.length === 0 && page.next === cursor) return { rows: [], next: null };
      return page;
    },
    close: () => Promise.resolve(),
  };
}

export function pageReader<Row>(
  definition: AnyBackfill<Row>,
  ctx: Ctx,
  size: number,
  input: unknown,
): PageReader<Row> {
  if (definition.pages !== undefined) return pagesReader(definition, definition.pages, ctx, input);
  const source = definition.source;
  assert(
    source !== undefined,
    `backfill "${definition.name}" reached its pass with neither source nor pages`,
    `pages: async ({ cursor }) => ({ rows, next }) on backfill({ name: "${definition.name}" })`,
  );
  return sourceReader((args) => source.call(definition, args), ctx, size);
}
