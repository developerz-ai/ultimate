// Single responsibility: the production `Transport` — core NATS for fanout, JetStream KV for the
// shared presence sets. Subscriptions are held as intent rather than as socket state, so a lost
// connection is re-established and re-subscribed underneath the caller: that is what makes a `sync`
// node stateless and lets any client resubscribe to any node.

import { type Clock, isUltimateError, logger, systemClock } from '@ultimat3/core';
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
        return await this.#establish();
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

  /**
   * One attempt, published only once it is whole. A connection parked in `#connection` before its
   * bucket and its subscriptions are up answers `connected` for a dial that rejected, keeps its
   * `onClose` — which then clears the connection that replaced it — and leaves half a rebind
   * behind, so the next dial binds the same subject a second time and every change arrives twice.
   * A failed attempt therefore takes its own socket down with it rather than leaking one per retry.
   */
  async #establish(): Promise<NatsConnection> {
    const connection = await this.#open();
    try {
      await ensureKvBucket(connection, this.#options.bucket, this.#options.presenceTtlMs ?? 30_000);
      for (const wanted of this.#wanted.values())
        wanted.live = await this.#bind(connection, wanted);
      // `close()` can land while an attempt is in flight, and it only closes what it can see:
      // publishing now would leave a socket open that nothing will ever close again.
      if (this.#closed) {
        throw new TransportUnavailableError({
          transport: this.name,
          reason: 'transport is closed',
        });
      }
    } catch (error) {
      for (const wanted of this.#wanted.values()) wanted.live = undefined;
      await connection.close();
      throw error;
    }
    this.#connection = connection;
    this.#losses = 0;
    return connection;
  }

  async #open(): Promise<NatsConnection> {
    const stream = await (this.#options.open ?? bunNatsStream)(this.#target);
    // The connection names itself in its own `onClose` so a drop can be matched against the live
    // one. It goes through a holder rather than a `const`, because a buffered `-ERR` closes the
    // session from inside `open()`, while a `const` binding would still be in its dead zone.
    const held: { connection: NatsConnection | undefined } = { connection: undefined };
    held.connection = await NatsConnection.open({
      stream,
      target: this.#target,
      name: 'ultimate',
      rng: this.#options.rng,
      onClose: (error) => this.#lost(error, held.connection),
      onError: (error) => this.#report(error, this.name),
    });
    return held.connection;
  }

  /**
   * A lost connection re-dials on its own rather than waiting for the next publish: a `sync` node
   * whose subscriptions are down is silently delivering nothing, which is worse than an error.
   */
  #lost(error: unknown, connection: NatsConnection | undefined): void {
    // Only the live connection may declare a loss. One abandoned mid-dial drops on its own clock,
    // and without this it would clear the subscriptions — and the reconnect budget — of whichever
    // connection replaced it, then report a failure the transport had already recovered from.
    if (connection === undefined || this.#connection !== connection) return;
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

  /**
   * Every background failure lands here — a lost connection, a throwing subscriber, an exhausted
   * reconnect. Dropping it when the caller passed no handler is what turns "no changes arrive"
   * into a debugging session with nothing to read, so the default emits rather than swallows.
   */
  #report(error: unknown, subject: string): void {
    const handler = this.#options.onError;
    if (handler !== undefined) {
      handler(error, subject);
      return;
    }
    logger.error('nats transport error', {
      transport: this.name,
      subject,
      code: isUltimateError(error) ? error.code : undefined,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
