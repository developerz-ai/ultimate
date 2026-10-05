// What a `LiveQueryRegistry` is built from, and the one ceiling it defaults. Split from
// `live-query.ts` at that file's size ceiling: the registry owns behaviour, this owns its knobs.

import type { Actor, Clock } from '@ultimat3/core';
import type { ReconnectBudget, ResumeSource } from './cursor';
import type { SubscriberGateOptions } from './subscriber-gate';
import type { Scheduler } from './thundering-herd';

export interface LiveQueryRegistryOptions extends SubscriberGateOptions {
  readonly source: ResumeSource;
  readonly budget?: ReconnectBudget;
  readonly clock?: Clock;
  readonly maxPerSocket?: number;
  readonly maxPerTenant?: number;
  /**
   * Live subscriptions one actor — or one anonymous client address — may hold on this node across
   * all its sockets. Defaults to `DEFAULT_MAX_PER_ACTOR` (1,000); the boot passes the app's
   * `realtime.maxSubscriptionsPerActor`.
   */
  readonly maxPerActor?: number;
  readonly tenantOf?: (actor: Actor | null) => string | null;
  /**
   * Distinct `(query, input)` pairs this node will hold at once. A `qid` derives from
   * client-chosen input, so without a ceiling one socket mints entries — a matcher, a row window,
   * a `WindowLock` and a fanout target each — until the process dies.
   */
  readonly maxEntries?: number;
  /**
   * How long one entry's SHARED snapshot read may hold its slot. Defaults to
   * `DEFAULT_READ_DEADLINE_MS`. Without it a `definition.snapshot` that never settles pinned the
   * slot for the life of the process and every later cold subscriber joined a promise nothing
   * would resolve — one wedged read taking every future subscriber of that query id with it.
   */
  readonly readDeadlineMs?: number;
  /** Injected so that deadline is provable without waiting for one. Production uses `setTimeout`. */
  readonly schedule?: Scheduler;
}

/**
 * Live `(query, input)` pairs one node holds. Reached, the next NEW pair is refused with
 * `X_SUBSCRIPTION_LIMIT`; subscribing to a pair that already exists keeps working, because the
 * cost this bounds is the entry, not the subscriber.
 */
export const DEFAULT_MAX_ENTRIES = 10_000;
