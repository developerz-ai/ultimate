// Single responsibility: the one adapter from the `nats` client to this package's port. It is the
// only file in the repo that imports `nats` — everything else speaks `NatsClient`, so the wire, the
// reconnect and the TLS upgrade are the library's and stay replaceable.
//
// WHERE FAILURES ARE TRANSLATED, and it is deliberately not all here. This file coded the calls
// that have no synchronous caller frame to catch them: `request`, `requestMany`, the dial, and the
// background `#watch` that is the only place a lost connection is announced. `publish` and
// `subscribe` are synchronous and stay raw — `NatsTransport.#translating` codes them, because
// `NatsTransportOptions.connect` is a PUBLIC injection seam: translating in this class would cover
// the one client the repo ships and leave every app-supplied one uncovered, and translating in both
// places would be two answers to one event. `unsubscribe()` is wrapped nowhere on purpose — it is
// synchronous, returns `void`, and its throw reaches the caller rather than being swallowed.
//
// This header said "every failure leaves here as an `UltimateError`" until 2026-08, which a reader
// took as a guarantee it never was.

import { connect, Events, headers, Match, type Msg, type MsgHdrs, type NatsConnection } from 'nats';
import { TransportUnavailableError } from './errors';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  type NatsClient,
  type NatsClientOptions,
  type NatsHeaders,
  type NatsMessage,
  type NatsMessageHandler,
  type NatsRequestManyOptions,
  type NatsRequestOptions,
  type NatsSubscription,
  type NatsTarget,
  parseNatsUrl,
} from './nats-client';

/** A message that has already left the library: the port's shape, read lazily off the headers. */
const messageOf = (message: Msg): NatsMessage => ({
  subject: message.subject,
  payload: message.data,
  status: message.headers?.code ?? 0,
  // `MsgHdrs.get` answers '' for a header the server never sent, and every header this package
  // reads is meaningless when empty — so one absent answer, rather than two.
  header: (name: string): string | undefined => {
    const value = message.headers?.get(name, Match.IgnoreCase);
    return value === undefined || value === '' ? undefined : value;
  },
});

const headersOf = (map: NatsHeaders | undefined): MsgHdrs | undefined => {
  if (map === undefined || map.size === 0) return undefined;
  const built = headers();
  for (const [name, value] of map) built.set(name, value);
  return built;
};

const unavailable = (target: NatsTarget, reason: string): TransportUnavailableError =>
  new TransportUnavailableError({
    transport: 'nats',
    // The URL is never echoed back — it carries the credentials.
    reason: `${target.host}:${target.port} — ${reason}`,
  });

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

class LibNatsClient implements NatsClient {
  readonly #connection: NatsConnection;
  readonly #target: NatsTarget;
  readonly #timeoutMs: number;
  readonly #report: (error: unknown) => void;
  #connected = true;

  constructor(connection: NatsConnection, target: NatsTarget, options: NatsClientOptions) {
    this.#connection = connection;
    this.#target = target;
    this.#timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#report = options.onError ?? ((): void => undefined);
    void this.#watch(options);
  }

  get version(): string {
    return this.#connection.info?.version ?? '';
  }

  get connected(): boolean {
    return this.#connected && !this.#connection.isClosed();
  }

  publish(subject: string, payload: Uint8Array): void {
    this.#connection.publish(subject, payload);
  }

  subscribe(subject: string, handler: NatsMessageHandler): NatsSubscription {
    const subscription = this.#connection.subscribe(subject, {
      // A callback rather than the async iterator: the iterator queues, and a `sync` node that
      // falls behind on one subject must drop nothing silently into a growing buffer.
      callback: (error, message) => {
        // A subscription's own failure — a permissions violation on the subject is the common one —
        // arrives here and nowhere else. Dropping it is a node delivering nothing, silently.
        if (error !== null) this.#report(unavailable(this.#target, `${subject}: ${error.message}`));
        else handler(messageOf(message));
      },
    });
    return { unsubscribe: () => subscription.unsubscribe() };
  }

  async request(
    subject: string,
    payload: Uint8Array,
    options: NatsRequestOptions = {},
  ): Promise<NatsMessage> {
    const built = headersOf(options.headers);
    try {
      const reply = await this.#connection.request(subject, payload, {
        timeout: this.#timeoutMs,
        ...(built === undefined ? {} : { headers: built }),
      });
      return messageOf(reply);
    } catch (error) {
      throw unavailable(this.#target, `${subject} did not answer: ${describe(error)}`);
    }
  }

  /**
   * A batch read ends on a message the caller recognises — a `204` end-of-batch or a `404` for a
   * prefix nobody has written. Breaking the loop is what releases the library's inbox subscription,
   * so the terminator is never collected and never awaited past.
   */
  async requestMany(
    subject: string,
    payload: Uint8Array,
    options: NatsRequestManyOptions,
  ): Promise<readonly NatsMessage[]> {
    const collected: NatsMessage[] = [];
    try {
      const replies = await this.#connection.requestMany(subject, payload, {
        maxWait: this.#timeoutMs,
      });
      for await (const reply of replies) {
        const message = messageOf(reply);
        if (options.until(message)) break;
        collected.push(message);
      }
    } catch (error) {
      throw unavailable(this.#target, `${subject} did not answer: ${describe(error)}`);
    }
    return collected;
  }

  async close(): Promise<void> {
    this.#connected = false;
    await this.#connection.close();
  }

  /**
   * The library's own status stream is the only place a background loss is announced. Nothing
   * awaits it, so it can neither throw nor end the process: a drop reports and flips `connected`,
   * a reconnect flips it back and tells the transport its cluster may be a new one.
   */
  async #watch(options: NatsClientOptions): Promise<void> {
    const report = options.onError ?? ((): void => undefined);
    try {
      for await (const status of this.#connection.status()) {
        if (status.type === Events.Disconnect) {
          this.#connected = false;
          report(unavailable(this.#target, 'the connection dropped'));
        } else if (status.type === Events.Reconnect) {
          this.#connected = true;
          options.onReconnect?.();
        } else if (status.type === Events.Error) {
          report(unavailable(this.#target, `the server reported ${String(status.data)}`));
        }
      }
      // The iterator ends when the connection is done: either `close()` or a reconnect budget spent.
      this.#connected = false;
      const failure = await this.#connection.closed();
      if (failure !== undefined) report(unavailable(this.#target, describe(failure)));
    } catch (error) {
      this.#connected = false;
      report(unavailable(this.#target, describe(error)));
    }
  }
}

/**
 * The production `NatsConnect`. The first dial retries on the same budget as a later loss
 * (`waitOnFirstConnect`), so a `sync` container that raced the bus into readiness recovers on its
 * own — and a budget that runs out rejects here rather than leaving a half-live connection behind.
 */
export const openNatsClient = async (options: NatsClientOptions): Promise<NatsClient> => {
  const target = parseNatsUrl(options.url);
  try {
    const connection = await connect({
      servers: [`${target.host}:${target.port}`],
      name: options.name ?? 'ultimate',
      waitOnFirstConnect: true,
      ...(options.maxReconnectAttempts === undefined
        ? {}
        : { maxReconnectAttempts: options.maxReconnectAttempts }),
      ...(options.reconnectDelay === undefined
        ? {}
        : { reconnectDelayHandler: options.reconnectDelay }),
      // The scheme is the only thing that can demand TLS before the server's INFO is read.
      ...(target.tls ? { tls: {} } : {}),
      ...(target.user === undefined ? {} : { user: target.user }),
      ...(target.pass === undefined ? {} : { pass: target.pass }),
      ...(target.token === undefined ? {} : { token: target.token }),
    });
    return new LibNatsClient(connection, target, options);
  } catch (error) {
    throw unavailable(target, describe(error));
  }
};
