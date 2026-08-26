// Single responsibility: the production `Transport` — core NATS for fanout, JetStream KV for the
// shared presence sets. The client underneath owns the wire and the reconnect, including
// re-establishing subscriptions, which is what makes a `sync` node stateless: a lost connection is
// re-dialled and re-subscribed underneath the caller, and this file keeps no socket state at all.

import {
  type Clock,
  finiteOption,
  isUltimateError,
  logger,
  renderThrowable,
  systemClock,
} from '@ultimat3/core';
import { TransportUnavailableError } from './errors';
import type { Transport, TransportHandler, TransportSet, TransportSubscription } from './fanout';
import type { NatsClient, NatsConnect } from './nats-client';
import { parseNatsUrl } from './nats-client';
import { ensureKvBucket } from './nats-jetstream';
import { NatsKvSet } from './nats-kv';
import { openNatsClient } from './nats-lib-client';
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
  readonly connect?: NatsConnect;
}

const DEFAULT_ATTEMPTS = 10;
const DEFAULT_PRESENCE_TTL_MS = 30_000;

/** The production bus: NATS subjects for fanout, a JetStream KV bucket for presence. */
export class NatsTransport implements Transport {
  readonly name = 'nats';
  readonly shared: TransportSet;
  readonly #options: NatsTransportOptions;
  readonly #connect: NatsConnect;
  readonly #backoff: BackoffPolicy;
  readonly #attempts: number;
  readonly #rng: Rng;
  #client: NatsClient | undefined;
  #dialing: Promise<NatsClient> | undefined;
  #retries = 0;
  #closed = false;

  constructor(options: NatsTransportOptions) {
    // Parsed here rather than at the first publish: a malformed NATS_URL is a boot-time fault, and
    // a container that reports itself healthy on one is a container nothing will ever page about.
    parseNatsUrl(options.url);
    this.#options = options;
    this.#connect = options.connect ?? openNatsClient;
    this.#backoff = options.backoff ?? defaultBackoff;
    this.#attempts = finiteOption(
      'createNatsTransport',
      'maxReconnectAttempts',
      options.maxReconnectAttempts ?? DEFAULT_ATTEMPTS,
    );
    this.#rng = options.rng ?? Math.random;
    this.shared = new NatsKvSet({
      client: () => this.#ensure(),
      bucket: options.bucket,
      clock: options.clock ?? systemClock,
    });
  }

  /** Fail fast at boot rather than on the first change: `/readyz` is meant to catch a dead bus. */
  async connect(): Promise<void> {
    await this.#ensure();
  }

  get connected(): boolean {
    return this.#client?.connected === true;
  }

  async publish(subject: string, payload: string): Promise<void> {
    const client = await this.#ensure();
    // `client.publish` is synchronous and refuses locally: a bad subject, a payload over the
    // server's `max_payload`, a connection torn down between the `#ensure` and this line. Those
    // are the LIBRARY's errors — or an app-supplied `connect`'s — so they arrive uncoded, and
    // `ChannelHub`'s bridge, `SocketRegistry` and the replicator all await this call.
    this.#translating(`publish to ${subject}`, () =>
      client.publish(subject, encoder.encode(payload)),
    );
  }

  /**
   * The subscription is the client's to keep: it survives a drop and comes back with the reconnect,
   * so there is no intent map here to re-bind from — and therefore no way for a re-bind to run
   * twice and double every change on the subject.
   */
  async subscribe(subject: string, handler: TransportHandler): Promise<TransportSubscription> {
    const client = await this.#ensure();
    // Same seam as `publish`: a permissions violation on the subject is refused here, not later.
    const live = this.#translating(`subscribe to ${subject}`, () =>
      client.subscribe(subject, (message) => {
        try {
          handler(decoder.decode(message.payload), message.subject);
        } catch (error) {
          this.#report(error, message.subject);
        }
      }),
    );
    return { subject, unsubscribe: () => live.unsubscribe() };
  }

  async close(): Promise<void> {
    this.#closed = true;
    const client = this.#client;
    this.#client = undefined;
    await client?.close();
  }

  /**
   * One dial, shared by every caller that races it. A client that has already been handed out is
   * reused whatever its state: while it is reconnecting the library is re-establishing that same
   * connection and its subscriptions, and a second dial alongside it would double every delivery.
   * A budget that ran out is a readiness failure, not a reason to start an unbounded retry here.
   */
  #ensure(): Promise<NatsClient> {
    if (this.#closed) {
      return Promise.reject(
        new TransportUnavailableError({ transport: this.name, reason: 'transport is closed' }),
      );
    }
    const current = this.#client;
    if (current !== undefined) return Promise.resolve(current);
    this.#dialing ??= this.#dial().finally(() => {
      this.#dialing = undefined;
    });
    return this.#dialing;
  }

  /**
   * One attempt, published only once it is whole. A client parked in `#client` before its bucket is
   * up answers `connected` for a dial that rejected, and the next caller then writes presence into
   * a bucket that does not exist. A failed attempt therefore closes its own connection rather than
   * leaking one per retry.
   */
  async #dial(): Promise<NatsClient> {
    const client = await this.#connect({
      url: this.#options.url,
      name: 'ultimate',
      maxReconnectAttempts: this.#attempts,
      // The library retries; the spread is ours, so a cluster restart does not bring every node
      // back on the same millisecond.
      reconnectDelay: () => backoffDelay(this.#retries++, this.#backoff, this.#rng),
      onError: (error) => this.#report(error, this.name),
      onReconnect: () => this.#recovered(),
    });
    try {
      await this.#ensureBucket(client);
      // `close()` can land while a dial is in flight, and it only closes what it can see:
      // publishing now would leave a connection open that nothing will ever close again.
      if (this.#closed) {
        throw new TransportUnavailableError({
          transport: this.name,
          reason: 'transport is closed',
        });
      }
    } catch (error) {
      await client.close();
      throw error;
    }
    this.#client = client;
    this.#retries = 0;
    return client;
  }

  #ensureBucket(client: NatsClient): Promise<void> {
    return ensureKvBucket(
      client,
      this.#options.bucket,
      finiteOption(
        'createNatsTransport',
        'presenceTtlMs',
        this.#options.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS,
      ),
    );
  }

  /**
   * A reconnect may have landed on a different cluster — a restarted single node, or a failover to
   * one that never held this bucket. The subscriptions came back with the client; the bucket is the
   * one thing the library knows nothing about, so it is re-asserted here. It is idempotent.
   */
  #recovered(): void {
    this.#retries = 0;
    const client = this.#client;
    if (client === undefined) return;
    void this.#ensureBucket(client).catch((error: unknown) => this.#report(error, this.name));
  }

  /**
   * One call into the client, with its refusal translated. An `UltimateError` passes through — the
   * port raises its own for a closed client, and re-wrapping would bury the code a caller branches
   * on — while anything else becomes `X_TRANSPORT_UNAVAILABLE` carrying the library's own words as
   * evidence. Never a bare `Error` out of this file: a raw `NatsError` has no code, no `fix:` and
   * nothing an operator can act on, which is the whole reason the port is here.
   */
  #translating<T>(what: string, call: () => T): T {
    try {
      return call();
    } catch (error) {
      if (isUltimateError(error)) throw error;
      throw new TransportUnavailableError({
        transport: this.name,
        reason: `${what} was refused: ${renderThrowable(error)}`,
      });
    }
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
      // `renderThrowable`, never `String(error)`: this is a reporter, and a throwable that fights
      // being read makes the report the thing that throws.
      error: renderThrowable(error),
    });
  }
}
