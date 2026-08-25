// The vocabulary a notification is addressed with: who it is for, and what happened.
//
// Both shapes are STRUCTURAL and deliberately thin. A `Recipient` is not a user row and never
// becomes one: this package cannot read an app's `users` table, and a channel that needs more than
// an id resolves it itself inside `deliver`.

import type { Schema } from '@ultimat3/schema';
import { t } from '@ultimat3/schema';

/**
 * Whoever a notification is addressed to.
 *
 * `id` is the only required field, because it is the only one the framework itself reads: it is
 * half of the delivery ledger's unique key and half of an inbox row. Everything else is a hint a
 * channel may use.
 *
 * `to` is ONE transport address — an email, a webhook URL, a device token — and not a bag keyed by
 * channel. A bag would be a `Record` this package reads with a data key, which is exactly the
 * prototype-index defect `bun run proto-index` refuses; and an app whose recipients carry two
 * different addresses already has the lookup, so its channel's `deliver` is where it belongs.
 */
export interface Recipient {
  readonly id: string;
  /** BCP-47. A channel that renders text for a person must not guess this. */
  readonly locale?: string | undefined;
  /** IANA zone. Required by the house rule for any date a channel renders. */
  readonly tz?: string | undefined;
  /** The transport address, when the app already has it at fan-out time. */
  readonly to?: string | undefined;
}

/**
 * Validated at the queue boundary, because a recipient list handed to `.enqueue()` is serialised
 * JSON by the time the worker reads it — the one place an unvalidated `to` could reach a channel.
 */
export const recipientSchema: Schema<unknown, Recipient> = t.object({
  id: t.string,
  locale: t.locale.optional(),
  tz: t.timezone.optional(),
  to: t.string.optional(),
}) as unknown as Schema<unknown, Recipient>;

/**
 * One thing that happened, once. `noticed` writes this as an `Event` row; here it is a value the
 * fan-out carries, and it is persisted only by the channels that persist — the inbox writes it,
 * the ledger records that a channel accepted it, and a notifier with neither installed writes no
 * rows at all.
 */
export interface NotifyEvent<Params = unknown> {
  /** The notifier's name — its queue key, its manifest row, and the ledger's first column. */
  readonly notifier: string;
  /**
   * What makes two invocations the SAME notification. Declared by the author as `key`, and used
   * twice on purpose: it is the job's `idempotencyKey` and the delivery ledger's event column.
   * Those are one question — "have we already told them this?" — asked at two layers, so two
   * values would be two answers that can disagree.
   */
  readonly key: string;
  /** The validated payload. */
  readonly params: Params;
  /** When the fan-out ran, from `ctx.now()` — never `new Date()`, so a frozen clock holds. */
  readonly at: Date;
}
