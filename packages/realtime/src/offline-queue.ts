// Tier 3: the durable mutation queue. Three invariants, all enforced here rather than documented:
//
//   1. **Order.** Mutations drain in client sequence order and stop at the first failure. A mutator
//      that assumed `like` ran before `unlike` must never see them swapped.
//   2. **Dedupe.** The idempotency key is the identity of the intent. Re-enqueueing a key that is
//      already queued (double click, replay after a crash) collapses onto the existing entry and
//      never gets a new sequence number.
//   3. **Only the server removes a mutation.** A `send` that returned proves the frame was handed
//      to a socket and nothing more, so a drained mutation is `inflight` — not `acked` — until an
//      `ack`/`fail` frame settles it, or a lost connection returns it to the queue.

import { renderThrowable, stringField } from '@ultimat3/core';
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
  /** Still to send. Not the queue depth: a sent mutation is unacknowledged, never unsent. */
  readonly remaining: number;
  readonly stoppedAt: string | null;
}

export type MutationSender = (mutation: QueuedMutation) => Promise<void>;

export class OfflineQueue {
  readonly #store: QueueStore;
  #mutations: QueuedMutation[] = [];
  #nextSeq = 1;
  #collapsed = 0;
  /** The drain lane: one pass at a time, in call order. See `drain`. */
  #draining: Promise<DrainReport> | null = null;
  /**
   * Which connection the current pass is draining into. The lane orders passes against each other
   * but `requeueInflight` is not a pass — it is a socket death, and it cannot reach into one that
   * is parked inside `send`. Bumped by every loss so a pass that resumes afterwards claims nothing.
   */
  #epoch = 0;

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

  /**
   * Everything the server has not settled yet, sorted by sequence — this is the only order
   * anything downstream is allowed to use, and the count a UI renders as "unsynced".
   */
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
    if (existing && existing.status !== 'failed') {
      this.#collapsed += 1;
      return existing;
    }
    // A terminally failed entry is a decision the server already made about this key, kept for the
    // UI — collapsing onto it makes an explicit idempotency key unusable for the rest of the
    // session, because nothing ever retries a denial. Re-issuing one is a NEW intent, so the old
    // entry is dropped and this one takes a new sequence at the back of the queue.
    if (existing)
      this.#mutations = this.#mutations.filter((candidate) => candidate.key !== args.key);
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
   *
   * **One pass at a time, chained rather than joined.** Two passes overlapping read the same entry
   * as sendable and put the same key on the wire twice — with the same seq, and the node dedupes
   * nothing — and a pass that started later could pass a mutation the pass in front of it has not
   * reached yet, which is the ordering guarantee above, gone. Chained rather than joined because a
   * caller that enqueued after the running pass began must still see its own mutation sent: it
   * gets a pass BEHIND that one, not that one's promise. The chain hangs off a settled shadow, so
   * one pass that rejected does not reject every pass behind it.
   */
  async drain(send: MutationSender): Promise<DrainReport> {
    const ahead = this.#draining?.then(
      () => undefined,
      () => undefined,
    );
    const pass = (ahead ?? Promise.resolve()).then(() => this.#pass(send));
    this.#draining = pass;
    try {
      return await pass;
    } finally {
      // Cleared only by the last pass in the chain, so the next drain starts fresh instead of
      // queueing behind a promise that settled a lifetime ago.
      if (this.#draining === pass) this.#draining = null;
    }
  }

  /**
   * A lost connection: everything handed to the dead socket goes back to `pending`, because a
   * `send` that returned is not an acknowledgement and those frames may never have left the tab.
   * At least once by construction — the idempotency key is what makes the resend safe.
   *
   * The epoch is bumped BEFORE the scan, not after: a pass parked at `await send(p1)` on the socket
   * that just died resumes into this same turn and would otherwise mark p2 and p3 `inflight` for a
   * connection that is gone. `#sendable` excludes `inflight`, so the next drain skips them, no ack
   * will ever arrive, and the writes are lost — which is exactly what invariant 3 forbids.
   */
  async requeueInflight(): Promise<number> {
    this.#epoch += 1;
    let returned = 0;
    for (const mutation of this.#mutations) {
      if (mutation.status !== 'inflight') continue;
      mutation.status = 'pending';
      returned += 1;
    }
    if (returned > 0) await this.#persist();
    return returned;
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

  /** Never sent on this connection. `inflight` is excluded: it is already on a socket. */
  #sendable(): readonly QueuedMutation[] {
    return this.#mutations
      .filter((mutation) => mutation.status === 'pending')
      .sort((a, b) => a.seq - b.seq);
  }

  /** One drain pass. Never called concurrently with itself — `drain` owns that. */
  async #pass(send: MutationSender): Promise<DrainReport> {
    const epoch = this.#epoch;
    const sendable = this.#sendable();
    // Nothing to do: a pass chained behind one that already sent everything must not rewrite the
    // durable state for the privilege of reporting zero.
    if (sendable.length === 0) {
      return { sent: 0, collapsed: this.#collapsed, remaining: 0, stoppedAt: null };
    }
    let sent = 0;
    for (const mutation of sendable) {
      // The connection this pass was draining into is gone, and `requeueInflight` has already
      // handed back what was on it. Everything left stays `pending` for the pass the next
      // connection arms — claiming it here would strand it on a socket that cannot answer.
      if (epoch !== this.#epoch) {
        return {
          sent,
          collapsed: this.#collapsed,
          remaining: this.#sendable().length,
          stoppedAt: mutation.key,
        };
      }
      mutation.status = 'inflight';
      mutation.attempts += 1;
      try {
        await send(mutation);
        // Stays `inflight`. `send` resolving means the frame reached a socket — a browser
        // `WebSocket.send` on a CLOSING socket discards it and returns normally — so calling that
        // an ack drops the mutation on exactly the socket death this queue exists to survive.
        // Only `ack`/`fail` (the server) or `requeueInflight` (a lost connection) moves it on.
        mutation.error = null;
        sent += 1;
      } catch (error) {
        mutation.status = 'pending';
        mutation.error = toQueueError(error);
        await this.#persist();
        return {
          sent,
          collapsed: this.#collapsed,
          remaining: this.#sendable().length,
          stoppedAt: mutation.key,
        };
      }
    }
    await this.#persist();
    return {
      sent,
      collapsed: this.#collapsed,
      remaining: this.#sendable().length,
      stoppedAt: null,
    };
  }

  async clear(): Promise<void> {
    this.#mutations = [];
    await this.#persist();
  }

  /**
   * A snapshot, never the live entries. `save` is a durable write — OPFS, IndexedDB — and it is
   * allowed to await before it reads. Handed the array itself, a store that resolves after the next
   * pass has moved on persists a status that was never true when it was called; `inflight` is the
   * one a reload cannot recover from, because `#sendable` skips it and no ack is coming.
   */
  async #persist(): Promise<void> {
    await this.#store.save({
      mutations: this.#mutations.map((mutation) => ({ ...mutation })),
      nextSeq: this.#nextSeq,
    });
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
  return {
    // `stringField`, not `shape?.code`: the sender is a transport the app supplied, so the probe
    // for "did it throw a coded error" is itself a property read on an app value. A getter that
    // throws escaped `drain`'s catch through the probe rather than the render — the same contract
    // break one line earlier than the one the comment below records.
    code: stringField(error, 'code') ?? 'X_TRANSPORT_UNAVAILABLE',
    // Whatever the sender threw. `String()` here escaped `drain`'s own catch, so the queue's
    // stop-at-the-first-failure contract broke on the failure it exists to record.
    cause: stringField(error, 'cause') ?? renderThrowable(error),
    fix: stringField(error, 'fix') ?? 'the queue retries on the next reconnect',
  };
}
