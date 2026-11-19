// Cross-node fanout. This interface is the reason `sync` nodes are stateless: every piece of state
// that must survive one node's death (subscription routing, presence) lives behind `Transport`,
// never in a node's heap. Subjects are NATS-shaped (`x.change.posts.org-1`) so the in-process
// default and the real bus route identically.

import { type Clock, systemClock } from '@ultimat3/core';
import { TransportUnavailableError } from './errors';

export type TransportHandler = (payload: string, subject: string) => void;

export interface TransportSubscription {
  readonly subject: string;
  unsubscribe(): void;
}

export interface TransportSetEntry {
  readonly member: string;
  readonly value: string;
  readonly expiresAt: number;
}

/**
 * TTL'd keyed sets on the bus (NATS KV / Redis hashes). Presence uses this so a lost node loses
 * nothing: members simply stop heartbeating and expire on their own.
 */
export interface TransportSet {
  put(key: string, member: string, value: string, ttlMs: number): Promise<void>;
  /** `false` when the member had already expired — the caller must re-`put` (that is a re-join). */
  touch(key: string, member: string, ttlMs: number): Promise<boolean>;
  drop(key: string, member: string): Promise<void>;
  entries(key: string): Promise<readonly TransportSetEntry[]>;
}

export interface Transport {
  readonly name: string;
  publish(subject: string, payload: string): Promise<void>;
  subscribe(subject: string, handler: TransportHandler): Promise<TransportSubscription>;
  readonly shared: TransportSet;
  /**
   * Told each time the connection behind this transport comes back from a drop. Fanout is
   * at-most-once, so whatever was published in between never arrived — and with no later message
   * there is no sequence number to notice it by. A subscriber that keeps derived state (a `sync`
   * node's windows) invalidates it here. Returns the unsubscribe. A transport with no connection
   * to lose never calls the listener.
   */
  onReconnect(listener: () => void): () => void;
  close(): Promise<void>;
}

/** NATS subject semantics: `*` matches one token, `>` matches one-or-more trailing tokens. */
export function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split('.');
  const s = subject.split('.');
  for (let i = 0; i < p.length; i += 1) {
    const token = p[i];
    if (token === '>') return s.length > i;
    if (i >= s.length) return false;
    if (token !== '*' && token !== s[i]) return false;
  }
  return p.length === s.length;
}

export interface InProcessTransportOptions {
  readonly clock?: Clock;
  /** A failing subscriber must not break fanout for the others. */
  readonly onError?: (error: unknown, subject: string) => void;
}

class InProcessSet implements TransportSet {
  readonly #keys = new Map<string, Map<string, TransportSetEntry>>();
  readonly #clock: Clock;
  #prunedAt = 0;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  async put(key: string, member: string, value: string, ttlMs: number): Promise<void> {
    const now = this.#clock.now().getTime();
    if (now >= this.#prunedAt + ttlMs) this.#prune(now);
    const bucket = this.#keys.get(key) ?? new Map<string, TransportSetEntry>();
    bucket.set(member, { member, value, expiresAt: now + ttlMs });
    this.#keys.set(key, bucket);
  }

  /**
   * Expiry on the store's own clock, as the KV's server does it (`nats-kv.ts`). Read-time expiry
   * alone kept every key nobody reads again — a forgotten room's sweep lease, which must outlive
   * the room by one TTL so a follower reads its last roster — for the life of the process. A full
   * pass at most once per TTL, the interval `sweepAll` already walks every room on.
   */
  #prune(now: number): void {
    this.#prunedAt = now;
    for (const [key, bucket] of this.#keys) {
      for (const entry of bucket.values()) if (entry.expiresAt <= now) bucket.delete(entry.member);
      if (bucket.size === 0) this.#keys.delete(key);
    }
  }

  async touch(key: string, member: string, ttlMs: number): Promise<boolean> {
    const entry = this.#keys.get(key)?.get(member);
    if (!entry || entry.expiresAt <= this.#clock.now().getTime()) return false;
    await this.put(key, member, entry.value, ttlMs);
    return true;
  }

  async drop(key: string, member: string): Promise<void> {
    const bucket = this.#keys.get(key);
    bucket?.delete(member);
    if (bucket && bucket.size === 0) this.#keys.delete(key);
  }

  async entries(key: string): Promise<readonly TransportSetEntry[]> {
    const bucket = this.#keys.get(key);
    if (!bucket) return [];
    const now = this.#clock.now().getTime();
    const live: TransportSetEntry[] = [];
    for (const entry of bucket.values()) {
      if (entry.expiresAt > now) live.push(entry);
      else bucket.delete(entry.member);
    }
    return live;
  }

  get size(): number {
    return this.#keys.size;
  }
}

/** Single-node default: `x dev`, tests, and small deployments that have not earned a bus yet. */
export class InProcessTransport implements Transport {
  readonly name = 'in-process';
  readonly shared: TransportSet;
  readonly #set: InProcessSet;
  readonly #handlers = new Map<string, Set<TransportHandler>>();
  readonly #onError: (error: unknown, subject: string) => void;
  #closed = false;

  constructor(options: InProcessTransportOptions = {}) {
    this.#set = new InProcessSet(options.clock ?? systemClock);
    this.shared = this.#set;
    this.#onError = options.onError ?? (() => undefined);
  }

  async publish(subject: string, payload: string): Promise<void> {
    this.#assertOpen();
    for (const [pattern, handlers] of this.#handlers) {
      if (!subjectMatches(pattern, subject)) continue;
      for (const handler of handlers) {
        try {
          handler(payload, subject);
        } catch (error) {
          this.#onError(error, subject);
        }
      }
    }
  }

  /** One process, no connection: there is nothing to come back from, so nothing is ever said. */
  onReconnect(): () => void {
    return () => undefined;
  }

  async subscribe(subject: string, handler: TransportHandler): Promise<TransportSubscription> {
    this.#assertOpen();
    const handlers = this.#handlers.get(subject) ?? new Set<TransportHandler>();
    handlers.add(handler);
    this.#handlers.set(subject, handlers);
    return {
      subject,
      unsubscribe: () => {
        handlers.delete(handler);
        if (handlers.size === 0) this.#handlers.delete(subject);
      },
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#handlers.clear();
  }

  get subjectCount(): number {
    return this.#handlers.size;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new TransportUnavailableError({ transport: this.name, reason: 'transport is closed' });
    }
  }
}

/**
 * Keys `transport.shared` holds, emptied ones included: the in-process read a leak test needs. A
 * module function, never a member — no caller of the public class has a use for it.
 */
export const inProcessKeyCount = (transport: InProcessTransport): number =>
  transport.shared instanceof InProcessSet ? transport.shared.size : 0;

// The production bus lives in `nats-transport.ts`: it needs a socket, a codec and a JetStream
// client, none of which belong in the file that defines what a transport *is*.
