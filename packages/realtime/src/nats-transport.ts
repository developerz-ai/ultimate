// Single responsibility: the production `Transport` — core NATS for fanout, JetStream KV for the
// shared presence sets. Subscriptions are held as intent rather than as socket state, so a lost
// connection is re-established and re-subscribed underneath the caller: that is what makes a `sync`
// node stateless and lets any client resubscribe to any node.

import { type Clock, isUltimateError, systemClock } from '@ultimat3/core';
import { TransportUnavailableError } from './errors';
import type { Transport, TransportHandler, TransportSet, TransportSubscription } from './fanout';
import { NatsConnection, type NatsSubscription } from './nats-connection';
import { ensureKvBucket } from './nats-jetstream';
import { NatsKvSet } from './nats-kv';
import { bunNatsStream, type NatsStream, type NatsTarget, parseNatsUrl } from './nats-socket';
import { type BackoffPolicy, backoffDelay, defaultBackoff, type Rng } from './thundering-herd';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface NatsTransportOptions {
  readonly url: string;
  /** KV bucket backing `shared`. Created on first connect when the cluster has none. */
  readonly bucket: string;
  readonly maxReconnectAttempts?: number;
  readonly backoff?: BackoffPolicy;
  readonly clock?: Clock;
  /** Presence TTL, only as the floor for the bucket's whole-stream age limit. */
  readonly presenceTtlMs?: number;
  /** A failing subscriber, or a connection lost in the background, must not break the process. */
  readonly onError?: (error: unknown, subject: string) => void;
  readonly rng?: Rng;
  /** Injected so the whole transport — reconnect included — runs in a test with no network. */
  readonly open?: (target: NatsTarget) => Promise<NatsStream>;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface Wanted {
  readonly subject: string;
  readonly handler: TransportHandler;
  live: NatsSubscription | undefined;
}

const DEFAULT_ATTEMPTS = 10;

/** The production bus: NATS subjects for fanout, a JetStream KV bucket for presence. */
export class NatsTransport implements Transport {
  readonly name = 'nats';
  readonly shared: TransportSet;
  readonly #target: NatsTarget;
  readonly #options: NatsTransportOptions;
  readonly #wanted = new Map<number, Wanted>();
  readonly #backoff: BackoffPolicy;
  readonly #attempts: number;
  readonly #rng: Rng;
  readonly #sleep: (ms: number) => Promise<void>;
  #connection: NatsConnection | undefined;
  #dialing: Promise<NatsConnection> | undefined;
  #next = 0;
  #losses = 0;
  #closed = false;

  constructor(options: NatsTransportOptions) {
    this.#target = parseNatsUrl(options.url);
    this.#options = options;
    this.#backoff = options.backoff ?? defaultBackoff;
    this.#attempts = options.maxReconnectAttempts ?? DEFAULT_ATTEMPTS;
    this.#rng = options.rng ?? Math.random;
    this.#sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.shared = new NatsKvSet({
      connection: () => this.#ensure(),
      bucket: options.bucket,
      clock: options.clock ?? systemClock,
    });
  }

  /** Fail fast at boot rather than on the first change: `/readyz` is meant to catch a dead bus. */
  async connect(): Promise<void> {
    await this.#ensure();
  }

  get connected(): boolean {
    return this.#connection !== undefined && !this.#connection.closed;
  }

  async publish(subject: string, payload: string): Promise<void> {
    const connection = await this.#ensure();
    await connection.publish(subject, encoder.encode(payload));
  }

  async subscribe(subject: string, handler: TransportHandler): Promise<TransportSubscription> {
    this.#next += 1;
    const id = this.#next;
    const wanted: Wanted = { subject, handler, live: undefined };
    this.#wanted.set(id, wanted);
    try {
      const connection = await this.#ensure();
      // The dial this may have triggered already re-bound everything it found registered, this
      // one included — binding again here would double every delivery on the subject.
      wanted.live ??= await this.#bind(connection, wanted);
    } catch (error) {
      this.#wanted.delete(id);
      throw error;
    }
    return {
      subject,
      unsubscribe: () => {
        this.#wanted.delete(id);
        void wanted.live?.unsubscribe().catch((error: unknown) => this.#report(error, subject));
        wanted.live = undefined;
      },
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#wanted.clear();
    const connection = this.#connection;
    this.#connection = undefined;
    await connection?.close();
  }

  #bind(connection: NatsConnection, wanted: Wanted): Promise<NatsSubscription> {
    return connection.subscribe(wanted.subject, (message) => {
      try {
        wanted.handler(decoder.decode(message.payload), message.subject);
      } catch (error) {
        this.#report(error, message.subject);
      }
    });
  }

  #ensure(): Promise<NatsConnection> {
    if (this.#closed) {
      return Promise.reject(
        new TransportUnavailableError({ transport: this.name, reason: 'transport is closed' }),
      );
    }
    const current = this.#connection;
    if (current !== undefined && !current.closed) return Promise.resolve(current);
    this.#dialing ??= this.#dial().finally(() => {
      this.#dialing = undefined;
    });
    return this.#dialing;
  }

  /** Retry is bounded: a bus that is down for longer than the budget is a readiness failure. */
  async #dial(): Promise<NatsConnection> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const connection = await this.#open();
        this.#connection = connection;
        this.#losses = 0;
        await ensureKvBucket(
          connection,
          this.#options.bucket,
          this.#options.presenceTtlMs ?? 30_000,
        );
        for (const wanted of this.#wanted.values())
          wanted.live = await this.#bind(connection, wanted);
        return connection;
      } catch (error) {
        // A protocol mismatch answers the same on every attempt — a server too old for per-message
        // TTL stays too old — so retrying only delays the one report that names the fix.
        const fatal = isUltimateError(error) && error.code === 'X_TRANSPORT_PROTOCOL';
        if (fatal || this.#closed || attempt >= this.#attempts) {
          throw isUltimateError(error)
            ? error
            : new TransportUnavailableError({
                transport: this.name,
                reason: `${this.#target.host}:${this.#target.port} — ${String(error)}`,
              });
        }
        await this.#sleep(backoffDelay(attempt, this.#backoff, this.#rng));
      }
    }
  }

  async #open(): Promise<NatsConnection> {
    const stream = await (this.#options.open ?? bunNatsStream)(this.#target);
    return await NatsConnection.open({
      stream,
      target: this.#target,
      name: 'ultimate',
      rng: this.#options.rng,
      onClose: (error) => this.#lost(error),
      onError: (error) => this.#report(error, this.name),
    });
  }

  /**
   * A lost connection re-dials on its own rather than waiting for the next publish: a `sync` node
   * whose subscriptions are down is silently delivering nothing, which is worse than an error.
   */
  #lost(error: unknown): void {
    this.#connection = undefined;
    for (const wanted of this.#wanted.values()) wanted.live = undefined;
    this.#report(error, this.name);
    if (this.#closed || this.#wanted.size === 0) return;
    this.#losses += 1;
    if (this.#losses > this.#attempts) return;
    void this.#recover();
  }

  async #recover(): Promise<void> {
    // Backoff first: a server that accepts and immediately drops must not become a hot loop.
    await this.#sleep(backoffDelay(this.#losses - 1, this.#backoff, this.#rng));
    if (this.#closed || this.connected) return;
    await this.#ensure().catch((error: unknown) => this.#report(error, this.name));
  }

  #report(error: unknown, subject: string): void {
    this.#options.onError?.(error, subject);
  }
}
