// Single responsibility: the production `Transport` — core NATS for fanout, JetStream KV for the
// shared presence sets. The client underneath owns the wire and the reconnect, including
// re-establishing subscriptions, which is what makes a `sync` node stateless. The one loss it does
// not own is its own end: a client closed for good once its reconnect budget is spent is replaced
// here, on our backoff, and every kept subscription is bound again on the new one.
//
// Two ways to open it, because two kinds of process hold one. A node that SERVES from the bus
// awaits `connect()` and refuses to boot without it; a process that only PUBLISHES calls
// `connectInBackground()` and boots regardless — its publishes are refused, typed and at once,
// until the dial lands.

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
import { openNatsClient } from './nats-open';
import { NatsSubscriptions } from './nats-subscriptions';
import { type BackoffPolicy, defaultBackoff, policyDelay, type Rng } from './thundering-herd';

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
  /**
   * When the presence bucket is asserted. `'dial'` (the default) is a node that serves presence: no
   * JetStream, no connection. `'first-use'` is a process that only publishes — it never reads
   * `shared`, so a server without JetStream, or without the bucket, must not cost it the bus.
   */
  readonly presenceBucket?: 'dial' | 'first-use';
}

export interface NatsConnectWait {
  /** Refuse with `X_TRANSPORT_UNAVAILABLE` once this long has passed without a connection. */
  readonly withinMs?: number | undefined;
  /** The `fix:` of that refusal — the caller knows which role is waiting and what it needs. */
  readonly fix?: string | undefined;
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
  /** False until the first dial lands: what a refusal says while a background dial is in flight. */
  #everUp = false;
  readonly #lazyBucket: boolean;
  /** Under `'first-use'`: the clients whose bucket has been asserted since they last connected. */
  readonly #bucketed = new WeakSet<NatsClient>();
  /** Set while no client is held and one is being dialled in the background; the attempt in flight. */
  #redialing: number | undefined;
  #redialLoop: Promise<void> | undefined;
  /** The last background dial's own refusal, for the cause of a `connect({ withinMs })` that gave up. */
  #lastFailure: string | undefined;
  #wakeRedial: (() => void) | undefined;
  readonly #subscriptions = new NatsSubscriptions();
  readonly #reconnectListeners = new Set<() => void>();

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
    this.#lazyBucket = options.presenceBucket === 'first-use';
    this.shared = new NatsKvSet({
      client: () => this.#presenceClient(),
      bucket: options.bucket,
      clock: options.clock ?? systemClock,
    });
  }

  /**
   * Fail fast at boot rather than on the first change: `/readyz` is meant to catch a dead bus.
   * Bare, it is ONE dial. With `withinMs` the dial is retried on our backoff for that long — a
   * node that raced the bus into readiness recovers on its own — and then refused, naming the
   * server, the wait and the last attempt's own failure. The retry is not stopped by the refusal;
   * `close()` stops it, and that is what a failed boot calls.
   */
  async connect(wait: NatsConnectWait = {}): Promise<void> {
    if (wait.withinMs === undefined) {
      await this.#ensure();
      return;
    }
    const withinMs = finiteOption('createNatsTransport', 'connect.withinMs', wait.withinMs);
    const target = parseNatsUrl(this.#options.url);
    // A real timer, never the injected clock: the wait bounds a container's boot, which the
    // kubelet counts in real seconds.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const last = this.#lastFailure === undefined ? '' : ` — last attempt: ${this.#lastFailure}`;
        reject(
          new TransportUnavailableError({
            transport: this.name,
            reason: `${target.host}:${target.port} did not accept a connection within ${withinMs}ms${last}`,
            ...(wait.fix === undefined ? {} : { fix: wait.fix }),
          }),
        );
      }, withinMs);
    });
    try {
      await Promise.race([this.#client === undefined ? this.#redial() : undefined, late]);
    } finally {
      clearTimeout(timer);
    }
    // The loop also ends when the transport is closed under it.
    if (this.#client === undefined) await this.#ensure();
  }

  /**
   * Dial without being waited for: retried on our backoff until it lands or `close()` runs, and
   * announced to the `onReconnect` listeners when it does. Until then every publish and subscribe
   * is refused at once (`#ensure`) — never parked behind the dial, never queued.
   */
  connectInBackground(): void {
    if (this.#closed || this.#client !== undefined) return;
    void this.#redial();
  }

  get connected(): boolean {
    return this.#client?.connected === true;
  }

  async publish(subject: string, payload: string): Promise<void> {
    const client = await this.#ensure();
    // The library BUFFERS a publish made while it reconnects, without bound, and replays the lot
    // when the server is back: a queue nobody sized, delivering events whose only meaning was
    // "re-read now" minutes late. A subscriber is told of the gap (`onReconnect`); the publisher
    // is told here.
    if (!client.connected) {
      throw new TransportUnavailableError({
        transport: this.name,
        reason: `publish to ${subject} was refused: the client is reconnecting to the bus`,
      });
    }
    // `client.publish` is synchronous and refuses locally: a bad subject, a payload over the
    // server's `max_payload`, a connection torn down between the `#ensure` and this line. Those
    // are the LIBRARY's errors — or an app-supplied `connect`'s — so they arrive uncoded, and
    // `ChannelHub`'s bridge, `SocketRegistry` and the replicator all await this call.
    this.#translating(`publish to ${subject}`, () =>
      client.publish(subject, encoder.encode(payload)),
    );
  }

  /**
   * A drop is the client's to recover: the subscription comes back with the library's reconnect,
   * untouched by this file. It is also KEPT here, for the one loss the library does not recover —
   * a client closed for good — and bound once on its replacement, never twice on one client.
   */
  async subscribe(subject: string, handler: TransportHandler): Promise<TransportSubscription> {
    const client = await this.#ensure();
    // Same seam as `publish`: a permissions violation on the subject is refused here, not later.
    const release = this.#subscriptions.add(
      client,
      subject,
      (message) => {
        try {
          handler(decoder.decode(message.payload), message.subject);
        } catch (error) {
          this.#report(error, message.subject);
        }
      },
      (call) => this.#translating(`subscribe to ${subject}`, call),
    );
    return { subject, unsubscribe: release };
  }

  /**
   * Told every time the client comes back from a drop. Fanout is at-most-once, so the gap between
   * the drop and this call is changes the subscriber never saw — and with no later message there
   * is no sequence number to notice it by. A `sync` node invalidates its windows on it. Returns
   * the unsubscribe.
   */
  onReconnect(listener: () => void): () => void {
    this.#reconnectListeners.add(listener);
    return () => {
      this.#reconnectListeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#wakeRedial?.();
    const client = this.#client;
    this.#client = undefined;
    await client?.close();
  }

  /**
   * One dial, shared by every caller that races it. A client that has already been handed out is
   * reused whatever its state: while it is reconnecting the library is re-establishing that same
   * connection and its subscriptions, and a second dial alongside it would double every delivery.
   * A client closed for good is not handed out: `#lost` clears it and `#redial` replaces it, and a
   * caller that lands meanwhile is refused at once rather than parked behind a dial that may take
   * the library's whole connect budget.
   */
  #ensure(): Promise<NatsClient> {
    if (this.#closed) {
      return Promise.reject(
        new TransportUnavailableError({ transport: this.name, reason: 'transport is closed' }),
      );
    }
    const current = this.#client;
    if (current !== undefined) return Promise.resolve(current);
    if (this.#redialing !== undefined) {
      return Promise.reject(
        new TransportUnavailableError({
          transport: this.name,
          reason: this.#everUp
            ? `the connection closed once its reconnect budget was spent, and re-dial attempt ${this.#redialing} is in progress`
            : `the bus has not connected yet, and dial attempt ${this.#redialing} is in progress`,
        }),
      );
    }
    return this.#dialOnce();
  }

  /** One dial, shared by every caller that races it. */
  #dialOnce(): Promise<NatsClient> {
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
    // The client is only known once the dial resolves, and the library may give up on it before
    // the bucket is asserted: both cases are caught by identity, never by a flag on the transport.
    let opened: NatsClient | undefined;
    let closedEarly = false;
    const client = await this.#connect({
      url: this.#options.url,
      name: 'ultimate',
      maxReconnectAttempts: this.#attempts,
      // The library retries; the spread is ours, so a cluster restart does not bring every node
      // back on the same millisecond.
      reconnectDelay: () => policyDelay(this.#backoff, ++this.#retries, this.#rng),
      onError: (error) => this.#report(error, this.name),
      onReconnect: () => this.#recovered(),
      onClosed: () => {
        if (opened === undefined) closedEarly = true;
        else this.#lost(opened);
      },
    });
    try {
      if (!this.#lazyBucket) await this.#ensureBucket(client);
      if (closedEarly) {
        throw new TransportUnavailableError({
          transport: this.name,
          reason: 'the connection closed for good while the KV bucket was being asserted',
        });
      }
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
    opened = client;
    this.#client = client;
    this.#everUp = true;
    this.#retries = 0;
    return client;
  }

  /** `shared`'s client: under `'first-use'` this is where the bucket is asserted, once per client. */
  async #presenceClient(): Promise<NatsClient> {
    const client = await this.#ensure();
    if (this.#lazyBucket && !this.#bucketed.has(client)) {
      await this.#ensureBucket(client);
      this.#bucketed.add(client);
    }
    return client;
  }

  /**
   * The library spent its reconnect budget and closed the client. Handing it out again is a node
   * that refuses every publish until somebody restarts it — and the liveness probe never asks the
   * bus — so it is forgotten here and replaced in the background, subscriptions included.
   */
  #lost(client: NatsClient): void {
    if (this.#closed || this.#client !== client) return;
    this.#client = undefined;
    this.#subscriptions.orphan();
    this.#report(
      new TransportUnavailableError({
        transport: this.name,
        reason: 'the connection closed once its reconnect budget was spent; re-dialling',
      }),
      this.name,
    );
    void this.#redial();
  }

  /**
   * Dial until a client is up or the transport is closed — the first dial of a process that does
   * not wait for the bus, and the replacement of a client the library gave up on. One loop however
   * many callers ask. Bounded by our backoff between attempts (capped at the policy's `maxMs`), so
   * a long outage costs one dial per interval rather than a spin. A dial that lands re-binds every
   * kept subscription and is announced: changes published in the gap are gone.
   */
  #redial(): Promise<void> {
    this.#redialLoop ??= this.#redialUntilUp().finally(() => {
      this.#redialLoop = undefined;
    });
    return this.#redialLoop;
  }

  async #redialUntilUp(): Promise<void> {
    try {
      for (let attempt = 1; !this.#closed && this.#client === undefined; attempt += 1) {
        this.#redialing = attempt;
        try {
          const client = await this.#dialOnce();
          this.#lastFailure = undefined;
          // Coded like a first subscribe's refusal; the subscription stays kept for the next client.
          for (const failure of this.#subscriptions.bindAll(client)) {
            this.#report(
              this.#coded(`re-subscribe to ${failure.subject}`, failure.error),
              failure.subject,
            );
          }
          this.#announce();
        } catch (error) {
          if (this.#closed) return;
          this.#lastFailure = renderThrowable(error);
          // Attempts 1, 2, 4, 8, …: an outage is said at once and then ever more rarely, rather
          // than once per dial per pod for as long as it lasts.
          if ((attempt & (attempt - 1)) === 0) this.#report(error, this.name);
          await this.#pause(policyDelay(this.#backoff, attempt, this.#rng));
        }
      }
    } finally {
      this.#redialing = undefined;
    }
  }

  /** A wait `close()` can cut short, so a closed transport never holds a timer for `maxMs`. */
  #pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.#wakeRedial = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.#wakeRedial = done;
    });
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
    // Not awaited: the library calls this from its status loop. The failure has one place to go.
    // A lazy bucket is forgotten instead, and asserted again by whoever next reads `shared`.
    if (this.#lazyBucket) this.#bucketed.delete(client);
    else void this.#ensureBucket(client).catch((error: unknown) => this.#report(error, this.name));
    this.#announce();
  }

  #announce(): void {
    for (const listener of [...this.#reconnectListeners]) {
      try {
        listener();
      } catch (error) {
        this.#report(error, this.name);
      }
    }
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
      throw this.#coded(what, error);
    }
  }

  #coded(what: string, error: unknown): unknown {
    if (isUltimateError(error)) return error;
    return new TransportUnavailableError({
      transport: this.name,
      reason: `${what} was refused: ${renderThrowable(error)}`,
    });
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
