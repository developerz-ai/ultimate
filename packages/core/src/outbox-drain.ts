/**
 * The one message a service worker posts to its window clients when the platform says the
 * connection is back: "drain your outbox now". Tier 0 because the SENDER is `@ultimat3/pwa`'s
 * emitted `sw.js` (tier 4) and the LISTENER is `@ultimat3/realtime`'s outbox (tier 3) — one literal,
 * one home, never a string each side retypes.
 */

/** `event.data.type` of the drain message. */
export const OUTBOX_DRAIN_MESSAGE = 'x-outbox-drain';

/** The whole message. It carries nothing else: the outbox lives in the page, not in the worker. */
export interface OutboxDrainMessage {
  readonly type: typeof OUTBOX_DRAIN_MESSAGE;
}
