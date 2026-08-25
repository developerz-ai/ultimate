// What a channel IS: a name plus one `deliver`, in two arities. Individual channels are called
// once per recipient; bulk channels once for the whole audience.
//
// The split is `noticed`'s and it is not cosmetic. An email is instantiated per person and a Slack
// post is one POST for everybody, so a framework that only knows the first shape makes an app send
// the same webhook a hundred times.

import type { Ctx } from '@ultimat3/core';
import type { NotifyEvent, Recipient } from './notification';

/** What every `deliver` gets, whichever arity. */
interface DeliveryCommon<Params> {
  readonly ctx: Ctx;
  /**
   * The events this delivery covers. One entry for an immediate send; every event the window
   * coalesced, oldest first, for a digest flush. A channel that ignores it and reads `event`
   * alone is correct for the immediate case and lossy for the digest one, which is why the field
   * is not optional.
   */
  readonly batch: readonly NotifyEvent<Params>[];
  /** The newest event in `batch` — the one a single-event channel renders. */
  readonly event: NotifyEvent<Params>;
  /** The run's cancellation folded with this step's ceiling. Hand it to `fetch`. */
  readonly signal: AbortSignal;
}

export interface DeliveryArgs<Params = unknown> extends DeliveryCommon<Params> {
  readonly recipient: Recipient;
}

export interface BulkDeliveryArgs<Params = unknown> extends DeliveryCommon<Params> {
  /** Everyone the preference gate allowed. Never empty — the fan-out skips an empty audience. */
  readonly recipients: readonly Recipient[];
}

export interface NotifyChannel<Params = unknown> {
  readonly name: string;
  readonly bulk: false;
  deliver(args: DeliveryArgs<Params>): Promise<void> | void;
}

export interface BulkNotifyChannel<Params = unknown> {
  readonly name: string;
  readonly bulk: true;
  deliver(args: BulkDeliveryArgs<Params>): Promise<void> | void;
}

export type AnyNotifyChannel<Params = unknown> = NotifyChannel<Params> | BulkNotifyChannel<Params>;

/**
 * One recipient per call. The name is durable — it is a column of the delivery ledger — so it is
 * given here rather than derived from a variable name that a bundler may rewrite.
 */
export function channel<Params = unknown>(
  name: string,
  deliver: (args: DeliveryArgs<Params>) => Promise<void> | void,
): NotifyChannel<Params> {
  return { name, bulk: false, deliver };
}

/**
 * One call for the whole audience. The ledger claims ONE row per (event, channel) rather than one
 * per recipient, because the send is one thing: half a bulk POST is not a state this package can
 * represent, and pretending otherwise would let a replay re-post to everybody to repair one
 * address.
 */
export function bulkChannel<Params = unknown>(
  name: string,
  deliver: (args: BulkDeliveryArgs<Params>) => Promise<void> | void,
): BulkNotifyChannel<Params> {
  return { name, bulk: true, deliver };
}

export const isBulkChannel = <Params>(
  value: AnyNotifyChannel<Params>,
): value is BulkNotifyChannel<Params> => value.bulk;
