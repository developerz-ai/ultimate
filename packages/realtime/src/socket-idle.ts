// The application idle budget a sync node evicts a silent socket on, and how often it asks. Split
// from `socket.ts` at its line ceiling.

/**
 * How long a socket may route no frame before `sync-node` evicts it. It is an APPLICATION
 * inactivity budget and not Bun's transport one: Bun's `idleTimeout` is renewed by its own
 * ping/pong, so a client whose TCP stack still answers pings while its frame loop is wedged holds
 * its grant, its subscriptions and its topic membership forever. A beating client sends a `hello`
 * every `DEFAULT_HEARTBEAT_MS` (15s), so this is eight missed beats.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

/**
 * How often to ask. A quarter of the budget, floored at a second: a socket is evicted within 25%
 * of its window of going quiet, and a node holding 50,000 of them pays one pass over the table
 * four times per window rather than once a second. Derived rather than configured — a second knob
 * is a second number that can disagree with the one it is a fraction of.
 */
export function idleSweepPeriodMs(idleTimeoutMs: number): number {
  return Math.max(1_000, Math.floor(idleTimeoutMs / 4));
}
