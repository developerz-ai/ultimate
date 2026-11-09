// Single responsibility: what the durable mutation queue IS on disk — an entry, a queue's state,
// one keyed change to it — and the in-memory store tests and SSR run it on. The queue's rules
// (order, dedupe, only the server removes) are `offline-queue.ts`'s, which re-exports these.

import type { ActionPin } from '@ultimat3/core/page';
import type { JsonValue } from './json';
import type { WireError } from './sync-protocol';

export type MutationStatus = 'pending' | 'inflight' | 'acked' | 'failed';

export interface QueuedMutation {
  /** Idempotency key. Supplied by the mutator, stable across retries and reloads. */
  readonly key: string;
  /** Monotonic per client. Never renumbered — rebase replays in this order. */
  readonly seq: number;
  readonly name: string;
  readonly input: JsonValue;
  /** The action's `http` pin, when the write was made against one (`pinned-wire.ts`). */
  readonly http?: ActionPin | undefined;
  readonly enqueuedAt: number;
  attempts: number;
  status: MutationStatus;
  error: WireError | null;
}

export interface QueueState {
  readonly mutations: readonly QueuedMutation[];
  readonly nextSeq: number;
}

/**
 * One change to the durable queue: these entries written BY KEY, these keys deleted, and the
 * sequence floor. Never the whole queue — two tabs of one user share the store, and a whole-queue
 * save let the last tab to save erase the other's queued write.
 */
export interface QueueChange {
  readonly puts: readonly QueuedMutation[];
  readonly deletes: readonly string[];
  readonly nextSeq: number;
}

/** Durability seam: IndexedDB in the browser (`page-outbox.ts`), memory in tests. */
export interface QueueStore {
  load(): Promise<QueueState>;
  write(change: QueueChange): Promise<void>;
}

export class MemoryQueueStore implements QueueStore {
  readonly #mutations = new Map<string, QueuedMutation>();
  #nextSeq = 1;

  async load(): Promise<QueueState> {
    return {
      mutations: [...this.#mutations.values()].map((m) => ({ ...m })),
      nextSeq: this.#nextSeq,
    };
  }

  async write(change: QueueChange): Promise<void> {
    for (const key of change.deletes) this.#mutations.delete(key);
    for (const mutation of change.puts) this.#mutations.set(mutation.key, { ...mutation });
    this.#nextSeq = Math.max(this.#nextSeq, change.nextSeq);
  }
}

/** The one way to build the in-process queue store; the class is a type in the barrel only (`X_FACTORY_NAME_SPELLING`). */
export function memoryQueueStore(): MemoryQueueStore {
  return new MemoryQueueStore();
}
