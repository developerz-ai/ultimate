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

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  async put(key: string, member: string, value: string, ttlMs: number): Promise<void> {
    const bucket = this.#keys.get(key) ?? new Map<string, TransportSetEntry>();
    bucket.set(member, { member, value, expiresAt: this.#clock.now().getTime() + ttlMs });
    this.#keys.set(key, bucket);
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
}

/** Single-node default: `x dev`, tests, and small deployments that have not earned a bus yet. */
export class InProcessTransport implements Transport {
  readonly name = 'in-process';
  readonly shared: TransportSet;
  readonly #handlers = new Map<string, Set<TransportHandler>>();
  readonly #onError: (error: unknown, subject: string) => void;
  #closed = false;

  constructor(options: InProcessTransportOptions = {}) {
    this.shared = new InProcessSet(options.clock ?? systemClock);
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

// The production bus lives in `nats-transport.ts`: it needs a socket, a codec and a JetStream
// client, none of which belong in the file that defines what a transport *is*.
