// One consumer run: open the stream at the saved cursor, then turn after turn — read a batch,
// handle it and save the cursor past it in ONE transaction, report progress, check the drain.
// Split from `consumer.ts` for the reason `backfill-pass.ts` is split from `backfill.ts`.
//
// No step per batch, unlike a backfill: the cursor lives in the app's own row, committed with the
// batch's effect, so a resumed run starts from `cursor.load` and steps would only retain history.

import type { Ctx } from '@ultimat3/core';
import { assert, logger, renderThrowable, throwIfAborted } from '@ultimat3/core';
import { withTransaction } from '@ultimat3/db';
import type { ConsumerDefinition, ConsumerInput, ConsumerReport } from './consumer-types';
import type { JobRunArgs } from './job';

/** Rows per transaction when a declaration names none. Each batch is one commit. */
export const DEFAULT_CONSUMER_BATCH = 100;

/**
 * How long a partly filled batch waits for its next item before it commits what it holds. Without
 * it a quiet stream would keep a batch in hand until `batch` items arrived — items read and never
 * committed, for as long as the stream stays quiet.
 */
export const CONSUMER_LINGER_MS = 50;

/** The note a consumer's progress carries, so `x jobs show` can tell its row from any job's. */
export const CONSUMER_PROGRESS_NOTE = 'consumer';

export interface ConsumerPlan<Item, C> {
  readonly definition: ConsumerDefinition<Item, C>;
  readonly size: number;
}

/** Answers `undefined` when `promise` has not settled within `ms`; the promise stays usable. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lapse = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, lapse]);
  } finally {
    clearTimeout(timer);
  }
}

/** Waits for `promise`, or throws the run's abort the moment the drain fires. */
async function untilAborted<T>(promise: Promise<T>, ctx: Ctx): Promise<T> {
  throwIfAborted(ctx);
  let stop: (() => void) | undefined;
  const aborted = new Promise<'aborted'>((resolve) => {
    stop = () => resolve('aborted');
    ctx.signal.addEventListener('abort', stop, { once: true });
  });
  try {
    const first = await Promise.race([promise, aborted]);
    if (first === 'aborted') throwIfAborted(ctx);
    return first as T;
  } finally {
    if (stop !== undefined) ctx.signal.removeEventListener('abort', stop);
  }
}

/**
 * Groups the stream into batches of at most `size`. The pull in flight when a batch closes is
 * carried into the next one, never dropped: an item already read is an item the next batch owns.
 */
function batcher<Item>(iterator: AsyncIterator<Item>, size: number, ctx: Ctx) {
  let pending: Promise<IteratorResult<Item>> | undefined;
  let ended = false;
  const advance = (): Promise<IteratorResult<Item>> => {
    if (pending === undefined) {
      pending = iterator.next();
      // A pull still in flight when a drain ends the run is awaited by nobody: its rejection is
      // the stream's to report, not an unhandled one in the worker.
      pending.catch(() => undefined);
    }
    return pending;
  };
  return {
    inFlight: (): boolean => pending !== undefined,
    async next(): Promise<readonly Item[] | null> {
      if (ended) return null;
      const first = await untilAborted(advance(), ctx);
      pending = undefined;
      if (first.done === true) {
        ended = true;
        return null;
      }
      const items: Item[] = [first.value];
      while (items.length < size) {
        const step = await within(advance(), CONSUMER_LINGER_MS);
        if (step === undefined) break;
        pending = undefined;
        if (step.done === true) {
          ended = true;
          break;
        }
        items.push(step.value);
      }
      return items;
    },
  };
}

/**
 * Closes the stream. Awaited only when no pull is in flight: an async generator queues `return()`
 * behind a pending `next()`, so awaiting it on a quiet stream would hold a drained run open.
 */
async function close<Item>(iterator: AsyncIterator<Item>, inFlight: boolean, name: string) {
  const closing = iterator.return?.();
  if (closing === undefined) return;
  const logged = closing.then(
    () => undefined,
    (error: unknown) => {
      logger.warn('jobs.consumer.close-failed', { consumer: name, error: renderThrowable(error) });
    },
  );
  if (!inFlight) await logged;
}

async function lagOf<Item, C>(
  definition: ConsumerDefinition<Item, C>,
  key: string,
  cursor: C | null,
): Promise<number> {
  if (definition.lag === undefined) return 0;
  const lag = await definition.lag({ key, cursor });
  assert(
    Number.isFinite(lag) && lag >= 0,
    `consumer "${definition.name}" lag() returned ${String(lag)} for key "${key}" — a lag is a finite number, zero or more`,
    `lag: ({ key, cursor }) => Math.max(0, head(key) - position(cursor)) on consumer({ name: "${definition.name}" })`,
  );
  return lag;
}

/** The run: until the stream ends (a normal return; the next arm reopens it) or a drain stops it. */
export async function consumerRun<Item, C>(
  plan: ConsumerPlan<Item, C>,
  args: JobRunArgs<ConsumerInput>,
): Promise<ConsumerReport> {
  const { definition, size } = plan;
  const { ctx } = args;
  const { key } = args.input;
  const signal = ctx.signal;
  let cursor = await definition.cursor.load(key);
  const iterator = definition.open({ key, cursor, ctx, signal })[Symbol.asyncIterator]();
  const pull = batcher(iterator, size, ctx);
  let batches = 0;
  let items = 0;
  try {
    for (;;) {
      // The drain check, between turns: a turn is whole or absent, so the cursor stays on the
      // last batch that committed.
      throwIfAborted(ctx);
      const batch = await pull.next();
      if (batch === null) break;
      const next = await withTransaction(async () => {
        const after = await definition.handle({ items: batch, key, ctx, signal });
        await definition.cursor.save(key, after);
        return after;
      });
      cursor = next;
      batches += 1;
      items += batch.length;
      // `total - done` is the lag: the job row's progress is the one place a run reports itself.
      args.progress(items, items + (await lagOf(definition, key, cursor)), CONSUMER_PROGRESS_NOTE);
    }
  } finally {
    await close(iterator, pull.inFlight(), definition.name);
  }
  return { key, batches, items };
}
