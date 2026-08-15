// Single responsibility: an in-memory nats-server — core subject routing plus the slice of
// JetStream KV the bus uses — implementing `NatsClient` directly. The `nats` library owns the wire
// now, so the fake emulates the server one level above it: tests get a multi-node bus under a
// sealed network, and the live test against a real server is what proves this fake is not lying.

import { type Clock, systemClock } from '@ultimat3/core';
import { TransportUnavailableError } from './errors';
import { subjectMatches } from './fanout';
import type {
  NatsClient,
  NatsClientOptions,
  NatsConnect,
  NatsHeaders,
  NatsMessage,
  NatsMessageHandler,
  NatsRequestManyOptions,
  NatsRequestOptions,
  NatsSubscription,
} from './nats-client';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EMPTY = new Uint8Array(0);

const DEFAULT_VERSION = '2.11.17';
const DEFAULT_URL = 'nats://fake.test:4222';
const DEFAULT_BATCH = 1_000;

const STATUS_OK = 0;
const STATUS_EOB = 204;
const STATUS_NOT_FOUND = 404;

const STREAM_INFO = '$JS.API.STREAM.INFO.';
const STREAM_CREATE = '$JS.API.STREAM.CREATE.';
const DIRECT_GET = '$JS.API.DIRECT.GET.';
const KV_PREFIX = '$KV.';

const NS_PER_MS = 1_000_000;
const MS_PER_SECOND = 1_000;

export interface FakeNatsOptions {
  /** What `NatsClient.version` answers — the string `assertServerVersion` reads. */
  readonly version?: string;
  /** TTL and `max_age` are judged by this clock, so a test advances time instead of sleeping. */
  readonly clock?: Clock;
}

interface StoredMessage {
  readonly subject: string;
  readonly payload: Uint8Array;
  /** The write's own headers, keys lowercased — a later read hands `KV-Operation` back from here. */
  readonly headers: ReadonlyMap<string, string>;
  readonly seq: number;
  readonly writtenAt: number;
  readonly expiresAt: number | undefined;
}

interface StreamRecord {
  readonly name: string;
  readonly config: Record<string, unknown>;
  readonly subjects: readonly string[];
  /** `max_msgs_per_subject: 1` — a write replaces the subject's current message rather than logging. */
  readonly history1: boolean;
  /** `max_age`, as milliseconds: the whole-stream ceiling over every per-message TTL. */
  readonly maxAgeMs: number | undefined;
}

/** What a client is allowed to ask of the broker it came from. Nothing else crosses the seam. */
interface BrokerPort {
  readonly version: string;
  up(): boolean;
  publish(subject: string, payload: Uint8Array): void;
  request(subject: string, payload: Uint8Array, headers: NatsHeaders | undefined): NatsMessage;
  requestMany(
    subject: string,
    payload: Uint8Array,
    until: (message: NatsMessage) => boolean,
  ): readonly NatsMessage[];
  release(client: FakeNatsClient): void;
}

const lowercased = (headers: NatsHeaders | undefined): ReadonlyMap<string, string> => {
  const map = new Map<string, string>();
  for (const [name, value] of headers ?? []) map.set(name.toLowerCase(), value);
  return map;
};

/** `headers` must already be lowercase-keyed: `header()` is case-insensitive by lowering the ask. */
const message = (
  subject: string,
  payload: Uint8Array,
  status: number,
  headers: ReadonlyMap<string, string>,
): NatsMessage => ({
  subject,
  payload,
  status,
  header: (name: string) => headers.get(name.toLowerCase()),
});

const json = (subject: string, body: unknown): NatsMessage =>
  message(subject, encoder.encode(JSON.stringify(body)), STATUS_OK, new Map());

const unavailable = (reason: string): TransportUnavailableError =>
  new TransportUnavailableError({ transport: 'nats', reason });

/** A request body is always json here; anything unreadable is treated as `{}`, as the server does. */
const bodyOf = (payload: Uint8Array): Record<string, unknown> => {
  const text = decoder.decode(payload);
  if (text === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
};

const stringList = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** One simulated node's connection. Not exported: callers only ever see it as a `NatsClient`. */
class FakeNatsClient implements NatsClient {
  readonly #broker: BrokerPort;
  readonly #options: NatsClientOptions;
  readonly #subscriptions = new Set<{
    readonly pattern: string;
    readonly handler: NatsMessageHandler;
  }>();
  #closed = false;
  #dropped: boolean;

  constructor(broker: BrokerPort, options: NatsClientOptions) {
    this.#broker = broker;
    this.#options = options;
    this.#dropped = !broker.up();
  }

  get version(): string {
    return this.#broker.version;
  }

  get connected(): boolean {
    return !this.#closed && !this.#dropped;
  }

  publish(subject: string, payload: Uint8Array): void {
    this.#assertOpen();
    // A publish into a dropped connection is lost, exactly as a real disconnect loses it.
    if (this.#dropped) return;
    this.#broker.publish(subject, payload);
  }

  subscribe(subject: string, handler: NatsMessageHandler): NatsSubscription {
    this.#assertOpen();
    // The subscription is held across a drop: re-establishing it is what the library is bought for.
    const entry = { pattern: subject, handler };
    this.#subscriptions.add(entry);
    return {
      unsubscribe: () => {
        this.#subscriptions.delete(entry);
      },
    };
  }

  async request(
    subject: string,
    payload: Uint8Array,
    options?: NatsRequestOptions,
  ): Promise<NatsMessage> {
    this.#assertOpen();
    this.#assertLive();
    return this.#broker.request(subject, payload, options?.headers);
  }

  async requestMany(
    subject: string,
    payload: Uint8Array,
    options: NatsRequestManyOptions,
  ): Promise<readonly NatsMessage[]> {
    this.#assertOpen();
    this.#assertLive();
    return this.#broker.requestMany(subject, payload, options.until);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#subscriptions.clear();
    this.#broker.release(this);
  }

  deliver(delivered: NatsMessage): void {
    if (!this.connected) return;
    for (const entry of [...this.#subscriptions]) {
      if (!subjectMatches(entry.pattern, delivered.subject)) continue;
      try {
        entry.handler(delivered);
      } catch (error) {
        // A subscriber that throws is the subscriber's problem, never the publisher's.
        this.#options.onError?.(error);
      }
    }
  }

  markDropped(error: unknown): void {
    if (this.#closed || this.#dropped) return;
    this.#dropped = true;
    this.#options.onError?.(error);
  }

  markRestored(): void {
    if (this.#closed || !this.#dropped) return;
    this.#dropped = false;
    this.#options.onReconnect?.();
  }

  get closed(): boolean {
    return this.#closed;
  }

  #assertOpen(): void {
    if (this.#closed) throw unavailable('the client is closed');
  }

  /** A request has an answer to wait for, so a dropped connection fails it rather than losing it. */
  #assertLive(): void {
    if (this.#dropped) throw unavailable('the connection dropped');
  }
}

/** An in-memory nats-server: core subject routing plus the slice of JetStream KV the bus uses. */
export class FakeNatsBroker {
  readonly #clock: Clock;
  readonly #version: string;
  readonly #clients = new Set<FakeNatsClient>();
  readonly #streams = new Map<string, StreamRecord>();
  readonly #failures: { readonly needle: string; remaining: number }[] = [];
  #messages: StoredMessage[] = [];
  #seq = 0;
  #up = true;

  /** Refuse the next dial: `fakeNatsConnect` rejects while this is true. */
  offline = false;

  constructor(options: FakeNatsOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#version = options.version ?? DEFAULT_VERSION;
  }

  /** One client per simulated node. Every client on one broker sees every other's publishes. */
  client(options: NatsClientOptions = { url: DEFAULT_URL }): NatsClient {
    const client = new FakeNatsClient(this.#port(), options);
    this.#clients.add(client);
    return client;
  }

  get clients(): readonly NatsClient[] {
    return [...this.#clients];
  }

  /** Streams currently declared — so a test asserts bucket creation rather than inferring it. */
  get streams(): readonly string[] {
    return [...this.#streams.keys()];
  }

  /** The config body a create declared, verbatim — a bucket's history, direct reads, TTL, max_age. */
  streamConfig(stream: string): Record<string, unknown> | undefined {
    return this.#streams.get(stream)?.config;
  }

  /**
   * The node came back with nothing in it: every stream and every message is gone, and the clients
   * are untouched. That is the state a bucket-asserting reconnect has to survive.
   */
  forget(): void {
    this.#streams.clear();
    this.#messages = [];
    this.#seq = 0;
  }

  /** The connection dropped underneath every client. */
  drop(reason = 'the bus went away'): void {
    this.#up = false;
    for (const client of this.#clients) client.markDropped(unavailable(reason));
  }

  /** The library got it back. */
  restore(): void {
    this.#up = true;
    for (const client of this.#clients) client.markRestored();
  }

  /** The next `count` requests whose subject contains `needle` fail as an unreachable bus would. */
  fail(needle: string, count = 1): void {
    this.#failures.push({ needle, remaining: count });
  }

  #port(): BrokerPort {
    return {
      version: this.#version,
      up: () => this.#up,
      publish: (subject, payload) => this.#publish(subject, payload),
      request: (subject, payload, headers) => this.#request(subject, payload, headers),
      requestMany: (subject, payload, until) => this.#requestMany(subject, payload, until),
      release: (client) => {
        this.#clients.delete(client);
      },
    };
  }

  #publish(subject: string, payload: Uint8Array): void {
    const delivered = message(subject, payload, STATUS_OK, new Map());
    for (const client of [...this.#clients]) {
      if (client.closed) continue;
      client.deliver(delivered);
    }
  }

  #request(subject: string, payload: Uint8Array, headers: NatsHeaders | undefined): NatsMessage {
    this.#maybeFail(subject);
    if (subject.startsWith(STREAM_INFO)) return this.#streamInfo(subject);
    if (subject.startsWith(STREAM_CREATE)) return this.#streamCreate(subject, payload);
    if (subject.startsWith(DIRECT_GET)) return this.#directGet(subject);
    if (subject.startsWith(KV_PREFIX)) return this.#store(subject, payload, headers);
    throw unavailable(`no responders for ${subject}`);
  }

  #requestMany(
    subject: string,
    payload: Uint8Array,
    until: (candidate: NatsMessage) => boolean,
  ): readonly NatsMessage[] {
    this.#maybeFail(subject);
    const body = bodyOf(payload);
    const filters = subject.startsWith(DIRECT_GET) ? stringList(body['multi_last']) : [];
    if (filters.length === 0) throw unavailable(`no responders for ${subject}`);
    const batch = numberOr(body['batch'], DEFAULT_BATCH);
    const matched = this.#current()
      .filter((stored) => filters.some((filter) => subjectMatches(filter, stored.subject)))
      .slice(0, batch);
    const replies = matched.map((stored) => this.#replyFor(stored));
    // A batch always terminates: `204 EOB` behind results, `404` when the filter matched nothing.
    replies.push(
      message(subject, EMPTY, matched.length > 0 ? STATUS_EOB : STATUS_NOT_FOUND, new Map()),
    );
    const collected: NatsMessage[] = [];
    for (const reply of replies) {
      if (until(reply)) break;
      collected.push(reply);
    }
    return collected;
  }

  #maybeFail(subject: string): void {
    const failure = this.#failures.find((entry) => subject.includes(entry.needle));
    if (failure === undefined) return;
    failure.remaining -= 1;
    if (failure.remaining <= 0) this.#failures.splice(this.#failures.indexOf(failure), 1);
    throw unavailable(`${subject} was refused`);
  }

  #streamInfo(subject: string): NatsMessage {
    const name = subject.slice(STREAM_INFO.length);
    const stream = this.#streams.get(name);
    return json(
      subject,
      stream === undefined
        ? { error: { code: STATUS_NOT_FOUND, err_code: 10_059, description: 'stream not found' } }
        : { config: { name } },
    );
  }

  #streamCreate(subject: string, payload: Uint8Array): NatsMessage {
    const name = subject.slice(STREAM_CREATE.length);
    const config = bodyOf(payload);
    const subjects = stringList(config['subjects']);
    const existing = this.#streams.get(name);
    // Same name, different subjects is the one create a server refuses outright.
    if (existing !== undefined && existing.subjects.join(' ') !== subjects.join(' ')) {
      return json(subject, {
        error: { code: 400, err_code: 10_065, description: 'stream name already in use' },
      });
    }
    const maxAge = numberOr(config['max_age'], 0);
    this.#streams.set(name, {
      name,
      config,
      subjects,
      history1: config['max_msgs_per_subject'] === 1,
      maxAgeMs: maxAge > 0 ? maxAge / NS_PER_MS : undefined,
    });
    return json(subject, { config: { name } });
  }

  /** A KV write: a publish that waits for JetStream's ack, so an unstored put never reads as one. */
  #store(subject: string, payload: Uint8Array, headers: NatsHeaders | undefined): NatsMessage {
    const stream = this.#streamFor(subject);
    if (stream === undefined) {
      return json(subject, { error: { code: 503, description: 'no responders' } });
    }
    const written = lowercased(headers);
    const now = this.#clock.now().getTime();
    const ttlSeconds = Number.parseInt(written.get('nats-ttl') ?? '', 10);
    const perMessage =
      Number.isNaN(ttlSeconds) || ttlSeconds <= 0 ? undefined : now + ttlSeconds * MS_PER_SECOND;
    const ceiling = stream.maxAgeMs === undefined ? undefined : now + stream.maxAgeMs;
    const limits = [perMessage, ceiling].filter((at): at is number => at !== undefined);
    this.#seq += 1;
    if (stream.history1) this.#messages = this.#messages.filter((m) => m.subject !== subject);
    this.#messages.push({
      subject,
      payload,
      headers: written,
      seq: this.#seq,
      writtenAt: now,
      expiresAt: limits.length === 0 ? undefined : Math.min(...limits),
    });
    return json(subject, { stream: stream.name, seq: this.#seq });
  }

  /** `…GET.<stream>.<subject>` is one exact key; the batch form goes through `requestMany`. */
  #directGet(subject: string): NatsMessage {
    const tail = subject.slice(DIRECT_GET.length);
    const dot = tail.indexOf('.');
    if (dot < 0) throw unavailable(`no responders for ${subject}`);
    const wanted = tail.slice(dot + 1);
    const found = this.#current().findLast((stored) => stored.subject === wanted);
    if (found === undefined) return message(subject, EMPTY, STATUS_NOT_FOUND, new Map());
    return this.#replyFor(found);
  }

  #replyFor(stored: StoredMessage): NatsMessage {
    const operation = stored.headers.get('kv-operation');
    const headers = new Map<string, string>([
      ['nats-subject', stored.subject],
      ['nats-sequence', String(stored.seq)],
      // The server's own write time, in the one format `Date.parse` round-trips.
      ['nats-time-stamp', new Date(stored.writtenAt).toISOString()],
    ]);
    if (operation !== undefined) headers.set('kv-operation', operation);
    return message(stored.subject, stored.payload, STATUS_OK, headers);
  }

  /** Every unexpired message, in write order, one per subject: expiry is judged, never swept. */
  #current(): readonly StoredMessage[] {
    const now = this.#clock.now().getTime();
    this.#messages = this.#messages.filter(
      (stored) => stored.expiresAt === undefined || stored.expiresAt > now,
    );
    const latest = new Map<string, StoredMessage>();
    for (const stored of this.#messages) latest.set(stored.subject, stored);
    return [...latest.values()];
  }

  #streamFor(subject: string): StreamRecord | undefined {
    for (const stream of this.#streams.values()) {
      if (stream.subjects.some((pattern) => subjectMatches(pattern, subject))) return stream;
    }
    return undefined;
  }
}

/** The `NatsConnect` a test injects in place of the real client. */
export const fakeNatsConnect =
  (broker: FakeNatsBroker): NatsConnect =>
  async (options: NatsClientOptions): Promise<NatsClient> => {
    if (broker.offline) {
      throw unavailable(`${options.url} refused the connection`);
    }
    return broker.client(options);
  };
