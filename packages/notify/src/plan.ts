// The declaration an app writes, and the resolved plan the fan-out runs. Two shapes rather than
// one: everything an author may express in `DurationInput` or omit is normalised ONCE at
// declaration, so the run body never re-parses a duration or re-decides a default per recipient.

import type { Ctx } from '@ultimat3/core';
import { finiteCount } from '@ultimat3/core';
import { parseDuration } from '@ultimat3/time';
import type { AnyNotifyChannel } from './channel';
import type { NotifyEvent, Recipient } from './notification';

/** `'5m'` | `300_000`. Numbers pass through so a caller may stay explicit, exactly as jobs does. */
export type NotifyDuration = string | number;

/**
 * `parseDuration` refuses every string it cannot read, so the STRING arm is already total. The
 * number arm is the hole: it passes straight through, and a `NaN` there makes `waitMs > slept`
 * false for every delivery (a declared delay that silently does not happen) and `at + windowMs`
 * `NaN` (a digest bucket whose `endsAt > at` never holds, so every event opens its own window and
 * the coalescer coalesces nothing). `option` names which declaration was wrong, since one notifier
 * may hold several.
 */
export const toDurationMs = (duration: NotifyDuration, option = 'duration'): number =>
  finiteCount(
    'notifier',
    option,
    typeof duration === 'number' ? duration : parseDuration(duration),
    0,
  );

/**
 * What a notifier is enqueued with.
 *
 * `noticed`'s `PostLiked.with(params).deliver(recipients)` in one object. Nested rather than
 * flattened: an app's params may legitimately carry a field called `recipients`, and a payload
 * that could collide with the framework's own reserved key is a bug waiting for the first app
 * whose notification is *about* recipients.
 */
export interface NotifyPayload<Params> {
  readonly params: Params;
  /**
   * The audience, when the caller already knows it. Omitted, the notifier's own `recipients`
   * resolver runs inside a durable step — which is the form to prefer, because it is re-derived
   * on the worker rather than serialised through the queue.
   */
  readonly recipients?: readonly Recipient[] | undefined;
}

/** What `if` / `unless` decide about. */
export interface DeliveryGate<Params> {
  readonly event: NotifyEvent<Params>;
  readonly ctx: Ctx;
}

export interface DigestWindow<Params> {
  /** How long the window stays open, from its FIRST event. Rolling, never calendar-aligned. */
  readonly window: NotifyDuration;
  /**
   * What coalesces together within one recipient's slot. Defaults to the notifier's name — every
   * `post.commented` for one person in one digest. Return a thread id for one digest per thread.
   */
  readonly group?: ((event: NotifyEvent<Params>) => string) | undefined;
}

export interface ChannelDelivery<Params> {
  readonly channel: AnyNotifyChannel<Params>;
  /**
   * How long to hold this channel before it fires. `noticed`'s `wait`, and it behaves the way
   * `noticed` promises and most hand-rolled versions do not: `if` and `unless` are evaluated
   * AFTER it, so a five-minute delay whose condition went false in minute three sends nothing.
   */
  readonly wait?: NotifyDuration | undefined;
  /** Fire only when this answers true. Evaluated after `wait`. */
  readonly if?: ((gate: DeliveryGate<Params>) => boolean | Promise<boolean>) | undefined;
  /** Fire unless this answers true. Both may be declared; both must pass. */
  readonly unless?: ((gate: DeliveryGate<Params>) => boolean | Promise<boolean>) | undefined;
  /** Coalesce into one delivery per recipient per window. Individual channels only. */
  readonly digest?: DigestWindow<Params> | undefined;
}

/** One delivery with every duration in ms and every default already decided. */
export interface ResolvedDelivery<Params> {
  readonly channel: AnyNotifyChannel<Params>;
  readonly waitMs: number;
  readonly when: ((gate: DeliveryGate<Params>) => boolean | Promise<boolean>) | undefined;
  readonly unless: ((gate: DeliveryGate<Params>) => boolean | Promise<boolean>) | undefined;
  readonly digestMs: number | undefined;
  readonly group: ((event: NotifyEvent<Params>) => string) | undefined;
}

export interface RecipientArgs<Params> {
  readonly input: Params;
  readonly ctx: Ctx;
}

/** Everything `runFanout` reads. Built once by `notifier()`, never rebuilt per run. */
export interface NotifyPlan<Params> {
  readonly name: string;
  readonly maxRecipients: number;
  /** Sorted by `waitMs` ascending — the fan-out sleeps the DELTA between one and the next, so a
   * channel with no wait fires immediately even when a later one waits an hour. */
  readonly deliveries: readonly ResolvedDelivery<Params>[];
  keyFor(params: Params): string;
  recipientsFor(args: RecipientArgs<Params>): Promise<readonly Recipient[]> | readonly Recipient[];
}

/** What one run reports, bounded so `x jobs show` can print it. */
export interface NotifyReport {
  readonly recipients: number;
  /** Deliveries this run actually handed to a channel. */
  readonly delivered: number;
  /** Suppressed by the preference gate. */
  readonly suppressed: number;
  /** Skipped by `if` / `unless`, counted per (recipient, channel) so it compares with `delivered`. */
  readonly skipped: number;
  /** Already `sent` in the ledger — a replay that correctly did nothing. */
  readonly replayed: number;
  /** Appended to an open digest window that somebody else owns the flush of. */
  readonly digested: number;
}
