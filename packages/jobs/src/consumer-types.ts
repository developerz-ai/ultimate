// The `consumer()` declaration's shape and what it hands back. Apart from `consumer.ts` so the
// factory, the turn loop (`consumer-loop.ts`) and the registry read one set of types.

import type { Ctx } from '@ultimat3/core';
import type { DurationInput } from './clock';
import type { JobHandle } from './job';
import type { RetryPolicy } from './retry';
import type { TaskHandle } from './task';
import type { JobTenant } from './tenant';

/** One run per key: the payload is the key, and nothing else a queue row could drift on. */
export interface ConsumerInput {
  readonly key: string;
}

/**
 * The app's own row, read and written through this seam — the reasoning `webhook-ledger.ts`
 * states: the app owns the table. `save` runs INSIDE the batch's transaction, so a batch and the
 * cursor past it commit together or not at all.
 */
export interface ConsumerCursor<C> {
  /** Where `key` stopped. `null` before its first committed batch. */
  load(key: string): Promise<C | null> | C | null;
  save(key: string, next: C): Promise<void> | void;
}

export interface ConsumerBatch<Item> {
  readonly items: readonly Item[];
  readonly key: string;
  readonly ctx: Ctx;
  /** The run's cancellation — a drain aborts it. Hand it to whatever the body calls. */
  readonly signal: AbortSignal;
}

export interface ConsumerDefinition<Item, C> {
  /** REQUIRED: a durable queue key, the idempotency key's prefix and the supervisor's name. */
  readonly name: string;
  /** REQUIRED, as on `job()`: the org a key's run acts under, from the key — or `'none'`. */
  readonly tenant: JobTenant<ConsumerInput>;
  /**
   * What should be running: one key, or one per account. Asked by the supervisor's arm run under
   * `tenant: 'none'`, so a tenant-scoped read here needs the app's own `crossTenant(reason, fn)`.
   */
  keys(args: { readonly ctx: Ctx }): Promise<readonly string[]> | readonly string[];
  /** The stream, from `cursor`. Any broker is the app's dependency, behind this one seam. */
  open(args: {
    readonly key: string;
    readonly cursor: C | null;
    readonly ctx: Ctx;
    readonly signal: AbortSignal;
  }): AsyncIterable<Item>;
  /**
   * One batch, inside a transaction, answering the cursor past it — which the framework hands to
   * `cursor.save` in the SAME transaction. At least once: a drained or failed batch is delivered
   * again, so the effect must be idempotent per item (item ids are the app's).
   */
  handle(batch: ConsumerBatch<Item>): Promise<C> | C;
  readonly cursor: ConsumerCursor<C>;
  /** Items per transaction, at most. Defaults to `DEFAULT_CONSUMER_BATCH`. */
  readonly batch?: number;
  readonly queue?: string;
  readonly retry?: RetryPolicy;
  /** How often the supervisor re-arms every key: whole minutes dividing an hour. Default `'1m'`. */
  readonly rearm?: DurationInput;
  /** How far behind `key` is, in the app's own unit. Reported on the run's progress. */
  lag?(args: { readonly key: string; readonly cursor: C | null }): Promise<number> | number;
  /** Refused (`X_CONSUMER_INVALID`): a consumer runs until its stream ends or a drain stops it. */
  readonly timeout?: never;
}

/** What one run reports when its stream ends. Bounded, so `x jobs show` can print it. */
export interface ConsumerReport {
  readonly key: string;
  readonly batches: number;
  readonly items: number;
}

export interface ConsumerHandle extends JobHandle<ConsumerInput> {
  /** The task re-arming every key at `rearm`. Registered at declaration under `<name>.supervisor`. */
  readonly supervisor: TaskHandle;
}
