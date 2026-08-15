// Tier 3: the durable mutation queue. Two invariants, both enforced here rather than documented:
//
//   1. **Order.** Mutations drain in client sequence order and stop at the first failure. A mutator
//      that assumed `like` ran before `unlike` must never see them swapped.
//   2. **Dedupe.** The idempotency key is the identity of the intent. Re-enqueueing a key that is
//      already queued (double click, replay after a crash) collapses onto the existing entry and
//      never gets a new sequence number.

import { renderCauseValue } from '@ultimat3/core';
import type { JsonValue } from './json';
import { type Frame, PROTOCOL_VERSION, type WireError } from './sync-protocol';

export type MutationStatus = 'pending' | 'inflight' | 'acked' | 'failed';

export interface QueuedMutation {
  /** Idempotency key. Supplied by the mutator, stable across retries and reloads. */
  readonly key: string;
  /** Monotonic per client. Never renumbered — rebase replays in this order. */
  readonly seq: number;
  readonly name: string;
  readonly input: JsonValue;
  readonly enqueuedAt: number;
  attempts: number;
  status: MutationStatus;
  error: WireError | null;
}

export interface QueueState {
  readonly mutations: readonly QueuedMutation[];
  readonly nextSeq: number;
}

/** Durability seam: OPFS/IndexedDB in the browser, memory in tests. */
export interface QueueStore {
  load(): Promise<QueueState>;
  save(state: QueueState): Promise<void>;
}

export class MemoryQueueStore implements QueueStore {
  #state: QueueState = { mutations: [], nextSeq: 1 };

  async load(): Promise<QueueState> {
    return this.#state;
  }

  async save(state: QueueState): Promise<void> {
    this.#state = { mutations: state.mutations.map((m) => ({ ...m })), nextSeq: state.nextSeq };
  }
}

export interface DrainReport {
  readonly sent: number;
  readonly collapsed: number;
  readonly remaining: number;
  readonly stoppedAt: string | null;
}

export type MutationSender = (mutation: QueuedMutation) => Promise<void>;

export class OfflineQueue {
  readonly #store: QueueStore;
  #mutations: QueuedMutation[] = [];
  #nextSeq = 1;
  #collapsed = 0;

  private constructor(store: QueueStore, state: QueueState) {
    this.#store = store;
    this.#mutations = state.mutations.map((mutation) => ({ ...mutation }));
    this.#nextSeq = state.nextSeq;
  }

  /** Rehydrates from durable storage, so a reload resumes the same queue with the same sequence. */
  static async open(store: QueueStore): Promise<OfflineQueue> {
    return new OfflineQueue(store, await store.load());
  }

  get size(): number {
    return this.#mutations.length;
  }

  get collapsed(): number {
    return this.#collapsed;
  }

  get nextSeq(): number {
    return this.#nextSeq;
  }

  find(key: string): QueuedMutation | undefined {
    return this.#mutations.find((mutation) => mutation.key === key);
  }

  /** Sorted by sequence. This is the only order anything downstream is allowed to use. */
  pending(): readonly QueuedMutation[] {
    return this.#mutations
      .filter((mutation) => mutation.status === 'pending' || mutation.status === 'inflight')
      .sort((a, b) => a.seq - b.seq);
  }

  all(): readonly QueuedMutation[] {
    return [...this.#mutations].sort((a, b) => a.seq - b.seq);
  }

  async enqueue(args: {
    key: string;
    name: string;
    input: JsonValue;
    at?: number;
  }): Promise<QueuedMutation> {
    const existing = this.find(args.key);
    if (existing) {
      this.#collapsed += 1;
      return existing;
    }
    const mutation: QueuedMutation = {
      key: args.key,
      seq: this.#nextSeq,
      name: args.name,
      input: args.input,
      enqueuedAt: args.at ?? 0,
      attempts: 0,
      status: 'pending',
      error: null,
    };
    this.#nextSeq += 1;
    this.#mutations.push(mutation);
    await this.#persist();
    return mutation;
  }

  /**
   * Drains in sequence order and stops at the first failure. Continuing past a failure is how a
   * sync engine reorders a user's intent — so it does not continue.
   */
  async drain(send: MutationSender): Promise<DrainReport> {
    let sent = 0;
    for (const mutation of this.pending()) {
      mutation.status = 'inflight';
      mutation.attempts += 1;
      try {
        await send(mutation);
        mutation.status = 'acked';
        mutation.error = null;
        sent += 1;
      } catch (error) {
        mutation.status = 'pending';
        mutation.error = toQueueError(error);
        await this.#persist();
        return {
          sent,
          collapsed: this.#collapsed,
          remaining: this.pending().length,
          stoppedAt: mutation.key,
        };
      }
    }
    await this.#persist();
    return { sent, collapsed: this.#collapsed, remaining: this.pending().length, stoppedAt: null };
  }

  /** Server acknowledged: the mutation leaves the queue and its rebase entry can be committed. */
  async ack(key: string): Promise<void> {
    const mutation = this.find(key);
    if (!mutation) return;
    mutation.status = 'acked';
    this.#mutations = this.#mutations.filter((candidate) => candidate.key !== key);
    await this.#persist();
  }

  /** Terminal failure (policy denial, validation): kept for the UI, never retried blindly. */
  async fail(key: string, error: WireError): Promise<void> {
    const mutation = this.find(key);
    if (!mutation) return;
    mutation.status = 'failed';
    mutation.error = error;
    await this.#persist();
  }

  async clear(): Promise<void> {
    this.#mutations = [];
    await this.#persist();
  }

  async #persist(): Promise<void> {
    await this.#store.save({ mutations: this.#mutations, nextSeq: this.#nextSeq });
  }
}

export function mutateFrame(mutation: QueuedMutation): Frame {
  return {
    type: 'mutate',
    v: PROTOCOL_VERSION,
    key: mutation.key,
    seq: mutation.seq,
    name: mutation.name,
    input: mutation.input,
  };
}

function toQueueError(error: unknown): WireError {
  const shape = error as { code?: unknown; cause?: unknown; fix?: unknown } | null;
  return {
    code: typeof shape?.code === 'string' ? shape.code : 'X_TRANSPORT_UNAVAILABLE',
    // Whatever the sender threw. `String()` here escaped `drain`'s own catch, so the queue's
    // stop-at-the-first-failure contract broke on the failure it exists to record.
    cause: typeof shape?.cause === 'string' ? shape.cause : renderCauseValue(error),
    fix: typeof shape?.fix === 'string' ? shape.fix : 'the queue retries on the next reconnect',
  };
}
