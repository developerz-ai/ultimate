// The page's outbox as an ISLAND reaches it: read off the page, never built. The page boot
// (`boot.ts`) is the one module that constructs it — IndexedDB, the queue, the drain listeners —
// so a writing island ships this reader and none of that (~7.5 kB it would otherwise carry).

import type { JsonValue } from './json';

export interface OutboxEntry {
  /** The idempotency key the write was first attempted under — the SAME key on every replay. */
  readonly key: string;
  /** The mutator's action name; the replay POSTs to `actionPath(name)`. */
  readonly name: string;
  readonly input: JsonValue;
}

/** What a hook asks of the outbox the boot opened: queue a write, list them, replay them. */
export interface OutboxHandle {
  enqueue(entry: OutboxEntry): Promise<void>;
  replay(): Promise<unknown>;
  pending(): readonly OutboxEntry[];
  /** Settles once the current principal's queue is open. */
  readonly ready: Promise<void>;
}

/** Where the page keeps it: shared by every bundle on the page, as the record store is. */
export const OUTBOX_KEY: unique symbol = Symbol.for('ultimate.outbox');
export type OutboxHost = { [OUTBOX_KEY]?: OutboxHandle };

/** The outbox the page boot opened, or `undefined` on a page with no boot (nothing persisted). */
export function peekOutbox(): OutboxHandle | undefined {
  return (globalThis as OutboxHost)[OUTBOX_KEY];
}
