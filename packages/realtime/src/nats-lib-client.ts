// Single responsibility: the one adapter from the `nats` client to this package's port. It is the
// only file in the repo that imports `nats` — everything else speaks `NatsClient`, so the wire, the
// reconnect and the TLS upgrade are the library's and stay replaceable.
//
// WHERE FAILURES ARE TRANSLATED, and it is deliberately not all here. This file coded the calls
// that have no synchronous caller frame to catch them: `request`, `requestMany`, the dial, and the
// background `#watch`/`#watchClosed`, the only places a lost connection is announced. `publish` and
// `subscribe` are synchronous and stay raw — `NatsTransport.#translating` codes them, because
// `NatsTransportOptions.connect` is a PUBLIC injection seam: translating in this class would cover
// the one client the repo ships and leave every app-supplied one uncovered, and translating in both
// places would be two answers to one event. `unsubscribe()` is wrapped nowhere on purpose — it is
// synchronous, returns `void`, and its throw reaches the caller rather than being swallowed.
//
// This header said "every failure leaves here as an `UltimateError`" until 2026-08, which a reader
// took as a guarantee it never was.

import { finiteOption, renderThrowable } from '@ultimat3/core';
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

/**
 * The caught value as text, for the `reason` that becomes an `X_TRANSPORT_UNAVAILABLE`. Core's
 * total renderer and never `String(error)`: this text is built inside a `catch` block that has
 * nothing left to answer with, and `String()` raises on a null-prototype throwable — which a
 * library that is not this framework's may hand over.
 */
const describe = (error: unknown): string => renderThrowable(error);

class LibNatsClient implements NatsClient {
  readonly #connection: NatsConnection;
  readonly #target: NatsTarget;
  readonly #timeoutMs: number;
  readonly #report: (error: unknown) => void;
  #connected = true;
  /** Our own `close()` ends the status stream too, and that end is not the library giving up. */
  #closing = false;

  constructor(connection: NatsConnection, target: NatsTarget, options: NatsClientOptions) {
    this.#connection = connection;
    this.#target = target;
    this.#timeoutMs = finiteOption(
      'the nats client',
      'requestTimeoutMs',
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
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
    this.#closing = true;
    this.#connected = false;
    await this.#connection.close();
  }

  /**
   * The library's own status stream is the only place a drop or a recovery is announced. Nothing
   * awaits it, so it can neither throw nor end the process: a drop reports and flips `connected`,
   * a reconnect flips it back and tells the transport its cluster may be a new one.
   */
  async #watch(options: NatsClientOptions): Promise<void> {
    const report = options.onError ?? ((): void => undefined);
    const stream = this.#connection.status();
    void this.#watchClosed(options, stream);
    try {
      for await (const status of stream) {
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
    } catch (error) {
      this.#connected = false;
      report(unavailable(this.#target, describe(error)));
    }
  }

  /**
   * The end of the connection, read off `closed()` — never off the status stream, which in
   * nats@2.29.3 does NOT end when the connection closes (the library stops its protocol's
   * listeners, not the connection's). A close we did not ask for is the library giving up on its
   * reconnect budget: `onClosed`, so the transport replaces this client rather than handing a dead
   * one out forever. The stream is stopped here, or every replaced client leaks a pending loop.
   */
  async #watchClosed(options: NatsClientOptions, stream: unknown): Promise<void> {
    let failure: unknown;
    try {
      failure = await this.#connection.closed();
    } catch (error) {
      failure = error;
    }
    this.#connected = false;
    stopStream(stream);
    if (this.#closing) return;
    if (failure !== undefined) options.onError?.(unavailable(this.#target, describe(failure)));
    options.onClosed?.();
  }
}

/** `QueuedIterator.stop()` is the library's, and missing from the `AsyncIterable` it is typed as. */
const stopStream = (stream: unknown): void => {
  if (typeof stream !== 'object' || stream === null || !('stop' in stream)) return;
  const stop: unknown = stream.stop;
  if (typeof stop === 'function') stop.call(stream);
};

/**
 * The production `NatsConnect`: ONE first dial, refused at once when the server is not there.
 *
 * Deliberately not `waitOnFirstConnect`. Until 2026-10 it was set, on the reading that the first
 * dial "retries on the same budget as a later loss" — it does not: in nats@2.29.3 a failed first
 * dial under that option `continue`s past the attempt counter, so it retries FOREVER, and the
 * promise this returns never settles while the server is down. Every role awaited it at boot, so
 * a pod that restarted during a NATS outage hung before it bound a socket. The retry is the
 * transport's (`NatsTransport.#redial`), on our backoff, where `close()` can end it.
 */
export const openNatsClient = async (options: NatsClientOptions): Promise<NatsClient> => {
  const target = parseNatsUrl(options.url);
  // Screened BEFORE the try, and before the dial. Two reasons, and the second is why it is not a
  // line further down: the value is FORWARDED to the library rather than compared here, so there is
  // no `??` for `bun run finite-bounds` to see — the same conditional-spread shape that hid the
  // sync node's four socket ceilings; and inside the `try`, the catch below would re-render a
  // misconfiguration as `X_TRANSPORT_UNAVAILABLE`, which is a bus outage nobody can fix by looking
  // at the bus. `-1` stays legal: that is the library's "reconnect forever".
  const maxReconnectAttempts =
    options.maxReconnectAttempts === undefined
      ? undefined
      : finiteOption('the nats client', 'maxReconnectAttempts', options.maxReconnectAttempts);
  try {
    const connection = await connect({
      servers: [`${target.host}:${target.port}`],
      name: options.name ?? 'ultimate',
      ...(maxReconnectAttempts === undefined ? {} : { maxReconnectAttempts }),
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
