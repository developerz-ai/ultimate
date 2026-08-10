// Single responsibility: one NATS session over a `NatsStream` — the INFO/TLS/CONNECT handshake, the
// read loop that turns operations into subscription callbacks, and request/reply over an inbox.
// It speaks only in operations, never in bytes on a socket, so the whole session runs in a test.

import { TransportProtocolError, TransportUnavailableError } from './errors';
import {
  connectMessage,
  type NatsConnectOptions,
  PING_MESSAGE,
  PONG_MESSAGE,
  pubMessage,
  subMessage,
  unsubMessage,
} from './nats-commands';
import {
  type NatsHeaders,
  type NatsMessage,
  NatsProtocolParser,
  type NatsServerInfo,
} from './nats-protocol';
import type { NatsStream, NatsTarget } from './nats-socket';
import type { Rng } from './thundering-herd';

export interface NatsConnectionOptions {
  readonly stream: NatsStream;
  readonly target: NatsTarget;
  readonly name?: string | undefined;
  /** The read loop ended: EOF, a socket fault, or a fatal `-ERR`. The transport reconnects. */
  readonly onClose?: ((error: unknown) => void) | undefined;
  /** A non-fatal server complaint — a permissions violation on one subject, say. */
  readonly onError?: ((error: unknown) => void) | undefined;
  /** Injected so an inbox prefix is deterministic under a seeded test. */
  readonly rng?: Rng | undefined;
  readonly requestTimeoutMs?: number | undefined;
}

export interface NatsSubscription {
  readonly sid: string;
  readonly subject: string;
  unsubscribe(): Promise<void>;
}

export type NatsMessageHandler = (message: NatsMessage) => void;

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

/**
 * A subject is interpolated straight into a control line, so a space or a CRLF in one would inject
 * a second command. This regex is a security boundary, not a style rule.
 */
const SUBJECT = /^[^\s.*>]+(\.[^\s.*>]+)*$/;
const SUBSCRIBE_SUBJECT = /^[^\s.]+(\.[^\s.]+)*$/;

const assertSubject = (subject: string, pattern: RegExp, what: string): void => {
  if (!pattern.test(subject)) {
    throw new TransportProtocolError({
      transport: 'nats',
      stage: what,
      detail: `"${subject}" is not a subject: tokens are dot-separated and carry no whitespace`,
    });
  }
};

const inboxToken = (rng: Rng): string =>
  Math.floor(rng() * 0xff_ff_ff_ff)
    .toString(16)
    .padStart(8, '0');

interface Pending {
  readonly collect: (message: NatsMessage) => boolean;
  readonly settle: (error: unknown) => void;
}

/** One connected NATS session. `open()` returns only once the server has answered the handshake. */
export class NatsConnection {
  readonly #stream: NatsStream;
  readonly #parser: NatsProtocolParser;
  readonly #handlers = new Map<string, NatsMessageHandler>();
  readonly #pending = new Map<string, Pending>();
  readonly #pongs: (() => void)[] = [];
  readonly #onClose: (error: unknown) => void;
  readonly #onError: (error: unknown) => void;
  readonly #inbox: string;
  readonly #requestTimeoutMs: number;
  #info: NatsServerInfo;
  #sid = 0;
  #reply = 0;
  #inboxReady = false;
  #closed = false;

  private constructor(
    options: NatsConnectionOptions,
    info: NatsServerInfo,
    inbox: string,
    parser: NatsProtocolParser,
  ) {
    this.#stream = options.stream;
    this.#parser = parser;
    this.#info = info;
    this.#inbox = inbox;
    this.#onClose = options.onClose ?? (() => undefined);
    this.#onError = options.onError ?? (() => undefined);
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** INFO, the in-band TLS upgrade, CONNECT, and the PING/PONG that proves the server accepted it. */
  static async open(options: NatsConnectionOptions): Promise<NatsConnection> {
    const stream = options.stream;
    const parser = new NatsProtocolParser();
    const info = await readInfo(stream, parser);
    if (options.target.tls || info.tlsRequired) {
      // Anything the server sent after INFO would be read as ciphertext once TLS is up, so it is a
      // wrong peer rather than an early arrival — the same guard the postgres handshake makes.
      if (parser.buffered > 0) {
        throw new TransportProtocolError({
          transport: 'nats',
          stage: 'tls',
          detail: `the server sent ${parser.buffered} bytes after INFO but before TLS`,
        });
      }
      stream.upgradeTls();
    }
    const credentials: NatsConnectOptions = {
      name: options.name ?? 'ultimate',
      tlsRequired: options.target.tls || info.tlsRequired,
      user: options.target.user,
      pass: options.target.pass,
      authToken: options.target.token,
    };
    await stream.write(connectMessage(credentials));
    await stream.write(PING_MESSAGE);
    await expectPong(stream, parser);
    const inbox = `_INBOX.${inboxToken(options.rng ?? Math.random)}`;
    // The handshake parser carries on: anything it still holds is already this session's traffic.
    const connection = new NatsConnection(options, info, inbox, parser);
    connection.#drain();
    void connection.#readLoop();
    return connection;
  }

  get info(): NatsServerInfo {
    return this.#info;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Live subscription count — what a reconnect has to re-establish. */
  get subscriptionCount(): number {
    return this.#handlers.size;
  }

  async publish(
    subject: string,
    payload: Uint8Array,
    options: { readonly replyTo?: string; readonly headers?: NatsHeaders } = {},
  ): Promise<void> {
    this.#assertOpen();
    assertSubject(subject, SUBJECT, 'publish');
    // The reply subject rides in the same control line as the subject, so a CRLF in it injects a
    // second command just as readily — one guard on `subject` alone is half a boundary.
    if (options.replyTo !== undefined) assertSubject(options.replyTo, SUBJECT, 'publish');
    if (payload.length > this.#info.maxPayload) {
      throw new TransportProtocolError({
        transport: 'nats',
        stage: 'publish',
        detail: `${payload.length} bytes exceeds the server's max_payload of ${this.#info.maxPayload}`,
        fix: 'raise max_payload in the nats-server config, or split the change into smaller frames',
      });
    }
    await this.#stream.write(pubMessage({ subject, payload, ...options }));
  }

  async subscribe(
    subject: string,
    handler: NatsMessageHandler,
    queue?: string,
  ): Promise<NatsSubscription> {
    this.#assertOpen();
    assertSubject(subject, SUBSCRIBE_SUBJECT, 'subscribe');
    this.#sid += 1;
    const sid = String(this.#sid);
    await this.#stream.write(subMessage(subject, sid, queue));
    // Registered only once the SUB is on the wire: a handler behind a rejected write is one no
    // server ever feeds, and `subscriptionCount` would hand it to the reconnect path as live.
    this.#handlers.set(sid, handler);
    return {
      sid,
      subject,
      unsubscribe: async () => {
        if (!this.#handlers.delete(sid) || this.#closed) return;
        await this.#stream.write(unsubMessage(sid));
      },
    };
  }

  /** One request, one reply. `no_responders` turns a subject nobody serves into a 503, not a hang. */
  async request(
    subject: string,
    payload: Uint8Array,
    options: { readonly headers?: NatsHeaders; readonly timeoutMs?: number } = {},
  ): Promise<NatsMessage> {
    const replies = await this.requestMany(subject, payload, { ...options, until: () => true });
    const first = replies[0];
    if (first === undefined) {
      throw new TransportUnavailableError({
        transport: 'nats',
        reason: `no reply arrived on ${subject}`,
      });
    }
    return first;
  }

  /**
   * A request whose answer is several messages — a JetStream batch read. `until` decides which
   * message ends the run, so the terminator stays with the API that defines it.
   */
  async requestMany(
    subject: string,
    payload: Uint8Array,
    options: {
      readonly headers?: NatsHeaders;
      readonly timeoutMs?: number;
      readonly until: (message: NatsMessage) => boolean;
    },
  ): Promise<readonly NatsMessage[]> {
    this.#assertOpen();
    await this.#ensureInbox();
    this.#reply += 1;
    const token = String(this.#reply);
    const collected: NatsMessage[] = [];
    const answer = new Promise<readonly NatsMessage[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(token);
        reject(
          new TransportUnavailableError({
            transport: 'nats',
            reason: `${subject} did not answer within ${options.timeoutMs ?? this.#requestTimeoutMs}ms`,
          }),
        );
      }, options.timeoutMs ?? this.#requestTimeoutMs);
      this.#pending.set(token, {
        collect: (message) => {
          collected.push(message);
          if (!options.until(message)) return false;
          clearTimeout(timer);
          this.#pending.delete(token);
          resolve(collected);
          return true;
        },
        settle: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    try {
      await this.publish(subject, payload, {
        replyTo: `${this.#inbox}.${token}`,
        ...(options.headers === undefined ? {} : { headers: options.headers }),
      });
    } catch (error) {
      // `answer` already carries a live timer and nobody downstream will await it now, so it is
      // settled and swallowed here — otherwise the timer rejects into an unhandled rejection one
      // whole timeout later, long after the caller saw the real cause.
      this.#pending.get(token)?.settle(error);
      this.#pending.delete(token);
      await answer.catch(() => undefined);
      throw error;
    }
    return await answer;
  }

  /** PING/PONG round trip: the server has processed everything written before it. */
  async flush(): Promise<void> {
    this.#assertOpen();
    // The PING goes first: a resolver parked behind a rejected write would be handed the next PONG
    // to arrive and report as flushed bytes the server never saw.
    await this.#stream.write(PING_MESSAGE);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flushed = new Promise<void>((resolve, reject) => {
      const parked = (): void => resolve();
      this.#pongs.push(parked);
      timer = setTimeout(() => {
        // Dropped from the queue first, or a late PONG resolves whoever now sits at its head.
        const index = this.#pongs.indexOf(parked);
        if (index >= 0) this.#pongs.splice(index, 1);
        reject(
          new TransportUnavailableError({
            transport: 'nats',
            reason: `the server did not answer PING within ${this.#requestTimeoutMs}ms`,
          }),
        );
      }, this.#requestTimeoutMs);
    });
    try {
      await flushed;
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#handlers.clear();
    this.#stream.close();
    this.#settleAll(
      new TransportUnavailableError({ transport: 'nats', reason: 'the connection was closed' }),
    );
  }

  #drain(): void {
    for (;;) {
      const operation = this.#parser.next();
      if (operation === undefined) return;
      this.#dispatch(operation);
    }
  }

  async #readLoop(): Promise<void> {
    try {
      for (;;) {
        const chunk = await this.#stream.read();
        if (chunk === undefined) break;
        this.#parser.push(chunk);
        this.#drain();
        if (this.#closed) return;
      }
      this.#fail(
        new TransportUnavailableError({
          transport: 'nats',
          reason: 'the server closed the socket',
        }),
      );
    } catch (error) {
      this.#fail(error);
    }
  }

  #dispatch(operation: ReturnType<NatsProtocolParser['next']>): void {
    if (operation === undefined) return;
    switch (operation.kind) {
      case 'info':
        // A cluster hands out a new INFO whenever the topology changes; the payload cap can move.
        this.#info = operation.info;
        return;
      case 'ping':
        void this.#stream.write(PONG_MESSAGE).catch((error: unknown) => this.#onError(error));
        return;
      case 'pong':
        this.#pongs.shift()?.();
        return;
      case 'ok':
        return;
      case 'err':
        this.#complain(operation.detail);
        return;
      case 'msg':
        this.#deliver(operation.message);
    }
  }

  #deliver(message: NatsMessage): void {
    const waiting = this.#pending.get(message.subject.slice(this.#inbox.length + 1));
    if (message.subject.startsWith(`${this.#inbox}.`) && waiting) {
      waiting.collect(message);
      return;
    }
    this.#handlers.get(message.sid)?.(message);
  }

  /** A permissions violation kills one subject; everything else kills the session. */
  #complain(detail: string): void {
    const error = new TransportUnavailableError({ transport: 'nats', reason: detail });
    if (/permissions violation/i.test(detail)) {
      this.#onError(error);
      return;
    }
    this.#fail(error);
  }

  #fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#handlers.clear();
    this.#stream.close();
    this.#settleAll(error);
    this.#onClose(error);
  }

  #settleAll(error: unknown): void {
    for (const pending of this.#pending.values()) pending.settle(error);
    this.#pending.clear();
    // A parked `flush()` would otherwise outlive the connection it was waiting on.
    while (this.#pongs.length > 0) this.#pongs.shift()?.();
  }

  async #ensureInbox(): Promise<void> {
    if (this.#inboxReady) return;
    await this.#stream.write(subMessage(`${this.#inbox}.*`, '0'));
    // Latched only after the write lands, so a refused SUB is retried by the next request rather
    // than leaving every one of them to report "did not answer" against an inbox nobody serves.
    // Two first requests racing here write the SUB twice, which the server ignores as a duplicate.
    this.#inboxReady = true;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new TransportUnavailableError({
        transport: 'nats',
        reason: 'the connection is closed',
      });
    }
  }
}

/** The first operation on any NATS connection is INFO — nothing else is legal before it. */
async function readInfo(stream: NatsStream, parser: NatsProtocolParser): Promise<NatsServerInfo> {
  for (;;) {
    const operation = parser.next();
    if (operation?.kind === 'info') return operation.info;
    if (operation !== undefined) {
      throw new TransportProtocolError({
        transport: 'nats',
        stage: 'handshake',
        detail: `the server opened with "${operation.kind}" rather than INFO`,
      });
    }
    const chunk = await stream.read();
    if (chunk === undefined) {
      throw new TransportUnavailableError({
        transport: 'nats',
        reason: 'the server closed the connection before sending INFO',
      });
    }
    parser.push(chunk);
  }
}

/** The PONG that proves CONNECT was accepted; an `-ERR` here is always a credentials problem. */
async function expectPong(stream: NatsStream, parser: NatsProtocolParser): Promise<void> {
  for (;;) {
    const operation = parser.next();
    if (operation?.kind === 'pong') return;
    if (operation?.kind === 'err') {
      throw new TransportUnavailableError({
        transport: 'nats',
        reason: `the server refused CONNECT: ${operation.detail}`,
      });
    }
    if (operation === undefined) {
      const chunk = await stream.read();
      if (chunk === undefined) {
        throw new TransportUnavailableError({
          transport: 'nats',
          reason: 'the server closed the connection during the handshake',
        });
      }
      parser.push(chunk);
    }
  }
}
