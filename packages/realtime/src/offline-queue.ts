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

import { renderThrowable, stringField } from '@ultimat3/core/page';
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

  /**
   * Rehydrates from durable storage, so a reload resumes the same queue with the same sequence.
   *
   * An `inflight` entry on disk belonged to a page that is gone, so it goes back to `pending`. Left
   * as it was, `#sendable` skipped it forever — no ack was coming to a page that no longer exists —
   * and every later write overtook it. The replay carries its idempotency key, so a write the old
   * page did get through is answered from the action's idempotency store, never applied twice.
   */
  static async open(store: QueueStore): Promise<OfflineQueue> {
    const queue = new OfflineQueue(store, await store.load());
    await queue.#reclaimInflight();
    return queue;
  }

  /**
   * Re-reads the durable queue, which another tab of the same user may have written since this one
   * opened. Call ONLY while this queue is the one draining — `page-outbox.ts` holds a Web Lock for
   * exactly that — because it reclaims every `inflight` entry as `pending`: with the lock held, no
   * other pass can have one on the wire.
   */
  async reload(): Promise<void> {
    const state = await this.#store.load();
    this.#mutations = state.mutations.map((mutation) => ({ ...mutation }));
    this.#nextSeq = Math.max(this.#nextSeq, state.nextSeq);
    await this.#reclaimInflight();
  }

  async #reclaimInflight(): Promise<void> {
    const reclaimed = this.#mutations.filter((mutation) => mutation.status === 'inflight');
    for (const mutation of reclaimed) mutation.status = 'pending';
    if (reclaimed.length > 0) await this.#persist(reclaimed);
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
    // By identity: `existing` IS the entry for this key, found above — no second key comparison.
    if (existing) this.#mutations = this.#mutations.filter((entry) => entry !== existing);
    // Another tab of the same user may have taken sequence numbers since this one loaded.
    this.#nextSeq = Math.max(this.#nextSeq, (await this.#store.load()).nextSeq);
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
    await this.#persist([mutation]);
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
    const back: QueuedMutation[] = [];
    for (const mutation of this.#mutations) {
      if (mutation.status !== 'inflight') continue;
      mutation.status = 'pending';
      returned += 1;
      back.push(mutation);
    }
    if (returned > 0) await this.#persist(back);
    return returned;
  }

  /** Server acknowledged: the mutation leaves the queue and its rebase entry can be committed. */
  async ack(key: string): Promise<void> {
    const mutation = this.find(key);
    if (!mutation) return;
    mutation.status = 'acked';
    // By identity: `find` already matched it, and a second comparison of the key is the same question.
    this.#mutations = this.#mutations.filter((entry) => entry !== mutation);
    await this.#persist([], [key]);
  }

  /** Terminal failure (policy denial, validation): kept for the UI, never retried blindly. */
  async fail(key: string, error: WireError): Promise<void> {
    const mutation = this.find(key);
    if (!mutation) return;
    mutation.status = 'failed';
    mutation.error = error;
    await this.#persist([mutation]);
  }

  /**
   * Re-asked at the top of every iteration, because `#sendable()` is a SNAPSHOT and the loop awaits
   * a network `send` inside it. An `ack` landing mid-pass removes its entry from the queue, a
   * `fail` marks it terminal and a `clear` drops all of them — and the pass, holding the snapshot,
   * re-sent an intent the server had already settled AND counted it in `DrainReport.sent`, so the
   * number a UI renders as "synced" was larger than the frames that left the tab.
   *
   * Deliberately NOT an `#epoch` bump in `ack`/`fail`: an ack arriving during a drain is the
   * ordinary case — the server answers frame 1 while the pass is on frame 2 — and invalidating the
   * pass would stop every drain against a server that answers promptly. The epoch means "the
   * connection this pass was draining into is gone", which is one mutation's settlement away from
   * nothing at all.
   */
  #stillSendable(mutation: QueuedMutation): boolean {
    return mutation.status === 'pending' && this.#mutations.includes(mutation);
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
    const touched: QueuedMutation[] = [];
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
      // Settled by the server, or dropped by `clear()`, since the snapshot was taken. Skipped
      // rather than stopping the pass: nothing behind it moved, so the order invariant holds.
      if (!this.#stillSendable(mutation)) continue;
      mutation.status = 'inflight';
      mutation.attempts += 1;
      touched.push(mutation);
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
        await this.#persist([mutation]);
        return {
          sent,
          collapsed: this.#collapsed,
          remaining: this.#sendable().length,
          stoppedAt: mutation.key,
        };
      }
    }
    // Only what this pass touched AND the queue still holds: an entry the server settled during the
    // pass was already deleted by `ack`, and writing it back would resurrect it.
    await this.#persist(touched.filter((mutation) => this.#mutations.includes(mutation)));
    return {
      sent,
      collapsed: this.#collapsed,
      remaining: this.#sendable().length,
      stoppedAt: null,
    };
  }

  async clear(): Promise<void> {
    const keys = this.#mutations.map((mutation) => mutation.key);
    this.#mutations = [];
    await this.#persist([], keys);
  }

  /**
   * Snapshots, never the live entries. `write` is a durable write — IndexedDB — and it is allowed
   * to await before it reads. Handed an entry itself, a store that resolves after the next pass has
   * moved on persists a status that was never true when it was called. BY KEY, never the whole
   * queue: a second tab's entries are not this tab's to overwrite or delete.
   */
  async #persist(puts: readonly QueuedMutation[], deletes: readonly string[] = []): Promise<void> {
    await this.#store.write({
      puts: puts.map((mutation) => ({ ...mutation })),
      deletes,
      nextSeq: this.#nextSeq,
    });
  }
}

/** A thrown value as the queue records it — `code`, `cause`, `fix`, never a throw of its own. */
export function toQueueError(error: unknown): WireError {
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
