// Single responsibility: an in-memory nats-server — core routing plus the slice of JetStream KV the
// bus uses. Tests run under a sealed network, so this is the only way to prove multi-node fanout
// without a broker; the live test against a real server is what proves this fake is not lying.

import { type Clock, systemClock } from '@ultimat3/core';
import { subjectMatches } from './fanout';
import type { NatsHeaders } from './nats-protocol';
import { parseHeaders } from './nats-protocol';
import type { NatsStream } from './nats-socket';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface FakeNatsOptions {
  readonly version?: string;
  readonly maxPayload?: number;
  readonly tlsRequired?: boolean;
  readonly clock?: Clock;
}

interface StoredMessage {
  readonly subject: string;
  readonly payload: string;
  readonly headers: ReadonlyMap<string, string>;
  readonly seq: number;
  readonly writtenAt: number;
  readonly expiresAt: number | undefined;
}

type ClientCommand =
  | { readonly kind: 'connect' | 'ping' | 'pong' }
  | { readonly kind: 'sub'; readonly subject: string; readonly sid: string }
  | { readonly kind: 'unsub'; readonly sid: string }
  | {
      readonly kind: 'pub';
      readonly subject: string;
      readonly replyTo: string | undefined;
      readonly headers: ReadonlyMap<string, string>;
      readonly payload: string;
    };

const crlf = (text: string): Uint8Array => encoder.encode(`${text}\r\n`);

const headerBlock = (headers: NatsHeaders, status?: string): string => {
  let block = `NATS/1.0${status === undefined ? '' : ` ${status}`}\r\n`;
  for (const [key, value] of headers) block += `${key}: ${value}\r\n`;
  return `${block}\r\n`;
};

const msgFrame = (
  subject: string,
  sid: string,
  replyTo: string | undefined,
  payload: string,
  headers: NatsHeaders | undefined,
  status?: string,
): Uint8Array => {
  const body = encoder.encode(payload);
  const reply = replyTo === undefined ? '' : ` ${replyTo}`;
  if (headers === undefined && status === undefined) {
    const control = `MSG ${subject} ${sid}${reply} ${body.length}\r\n`;
    return encoder.encode(`${control}${payload}\r\n`);
  }
  const block = headerBlock(headers ?? new Map(), status);
  const blockBytes = encoder.encode(block).length;
  const control = `HMSG ${subject} ${sid}${reply} ${blockBytes} ${blockBytes + body.length}\r\n`;
  return encoder.encode(`${control}${block}${payload}\r\n`);
};

/** Chunks the client wrote, turned into whole commands. The mirror of `NatsProtocolParser`. */
class ClientCommandReader {
  #text = '';

  push(chunk: Uint8Array): void {
    this.#text += decoder.decode(chunk);
  }

  next(): ClientCommand | undefined {
    const lineEnd = this.#text.indexOf('\r\n');
    if (lineEnd < 0) return undefined;
    const line = this.#text.slice(0, lineEnd);
    const args = line.split(/[ \t]+/).filter((part) => part.length > 0);
    const verb = (args[0] ?? '').toUpperCase();
    if (verb === 'PUB' || verb === 'HPUB') return this.#takePub(lineEnd, args, verb === 'HPUB');
    this.#text = this.#text.slice(lineEnd + 2);
    switch (verb) {
      case 'CONNECT':
        return { kind: 'connect' };
      case 'PING':
        return { kind: 'ping' };
      case 'PONG':
        return { kind: 'pong' };
      case 'SUB':
        // `SUB <subject> [queue] <sid>` — the sid is always last.
        return { kind: 'sub', subject: args[1] ?? '', sid: args[args.length - 1] ?? '' };
      case 'UNSUB':
        return { kind: 'unsub', sid: args[1] ?? '' };
      default:
        return undefined;
    }
  }

  #takePub(lineEnd: number, args: readonly string[], headered: boolean): ClientCommand | undefined {
    const counts = headered ? 2 : 1;
    const hasReply = args.length === 2 + counts + 1;
    const total = Number(args[args.length - 1] ?? '0');
    const headerBytes = headered ? Number(args[args.length - 2] ?? '0') : 0;
    const start = lineEnd + 2;
    if (this.#text.length < start + total + 2) return undefined;
    const body = this.#text.slice(start, start + total);
    this.#text = this.#text.slice(start + total + 2);
    const parsed = headered
      ? parseHeaders(encoder.encode(body.slice(0, headerBytes)))
      : { headers: new Map<string, string>() };
    return {
      kind: 'pub',
      subject: args[1] ?? '',
      replyTo: hasReply ? args[2] : undefined,
      headers: parsed.headers,
      payload: body.slice(headerBytes),
    };
  }
}

interface FakeClient {
  readonly reader: ClientCommandReader;
  readonly subscriptions: Map<string, string>;
  readonly push: (bytes: Uint8Array) => void;
  /** EOF for a reader parked on `read()` — a dropped client must never leave one hanging. */
  readonly end: () => void;
  open: boolean;
}

/** An in-memory nats-server. `connect()` hands back a `NatsStream` wired straight to it. */
export class FakeNatsServer {
  readonly #clients = new Set<FakeClient>();
  readonly #streams = new Map<string, Record<string, unknown>>();
  readonly #messages = new Map<string, StoredMessage>();
  readonly #options: FakeNatsOptions;
  readonly #clock: Clock;
  #seq = 0;

  constructor(options: FakeNatsOptions = {}) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
  }

  get connections(): number {
    return [...this.#clients].filter((client) => client.open).length;
  }

  /** Every current KV value, tombstones excluded — the assertion surface for a presence test. */
  get stored(): ReadonlyMap<string, string> {
    const live = new Map<string, string>();
    for (const message of this.#live()) live.set(message.subject, message.payload);
    return live;
  }

  /** A bus restart: every connection drops, and the client is expected to re-establish its subs. */
  dropAll(): void {
    for (const client of [...this.#clients]) this.#drop(client);
  }

  connect(): NatsStream {
    const queue: Uint8Array[] = [];
    let waiting: ((chunk: Uint8Array | undefined) => void) | undefined;
    const client: FakeClient = {
      reader: new ClientCommandReader(),
      subscriptions: new Map(),
      open: true,
      push: (bytes) => {
        const waiter = waiting;
        waiting = undefined;
        if (waiter) waiter(bytes);
        else queue.push(bytes);
      },
      end: () => {
        const waiter = waiting;
        waiting = undefined;
        waiter?.(undefined);
      },
    };
    this.#clients.add(client);
    client.push(crlf(`INFO ${JSON.stringify(this.#info())}`));
    return {
      read: () =>
        new Promise((resolve) => {
          const next = queue.shift();
          if (next !== undefined) resolve(next);
          else if (!client.open) resolve(undefined);
          else waiting = resolve;
        }),
      write: async (bytes) => {
        if (!client.open) return;
        client.reader.push(bytes);
        for (;;) {
          const command = client.reader.next();
          if (command === undefined) return;
          this.#handle(client, command);
        }
      },
      upgradeTls: () => undefined,
      close: () => this.#drop(client),
    };
  }

  #info(): Record<string, unknown> {
    return {
      server_id: 'FAKE',
      version: this.#options.version ?? '2.11.0',
      max_payload: this.#options.maxPayload ?? 1_048_576,
      headers: true,
      proto: 1,
      ...(this.#options.tlsRequired === true ? { tls_required: true } : {}),
    };
  }

  #drop(client: FakeClient): void {
    if (!client.open) return;
    client.open = false;
    client.subscriptions.clear();
    this.#clients.delete(client);
    client.end();
  }

  #handle(client: FakeClient, command: ClientCommand): void {
    switch (command.kind) {
      case 'connect':
      case 'pong':
        return;
      case 'ping':
        client.push(crlf('PONG'));
        return;
      case 'sub':
        client.subscriptions.set(command.sid, command.subject);
        return;
      case 'unsub':
        client.subscriptions.delete(command.sid);
        return;
      case 'pub':
        this.#publish(command);
    }
  }

  #publish(command: Extract<ClientCommand, { kind: 'pub' }>): void {
    if (command.subject.startsWith('$JS.API.')) {
      this.#jetStream(command);
      return;
    }
    if (command.subject.startsWith('$KV.')) {
      this.#store(command);
      return;
    }
    this.#route(command.subject, command.payload, command.replyTo, undefined);
  }

  #route(
    subject: string,
    payload: string,
    replyTo: string | undefined,
    headers: NatsHeaders | undefined,
    status?: string,
  ): void {
    for (const client of this.#clients) {
      if (!client.open) continue;
      for (const [sid, pattern] of client.subscriptions) {
        if (!subjectMatches(pattern, subject)) continue;
        client.push(msgFrame(subject, sid, replyTo, payload, headers, status));
      }
    }
  }

  #reply(command: Extract<ClientCommand, { kind: 'pub' }>, body: unknown): void {
    if (command.replyTo === undefined) return;
    this.#route(command.replyTo, JSON.stringify(body), undefined, undefined);
  }

  #store(command: Extract<ClientCommand, { kind: 'pub' }>): void {
    this.#seq += 1;
    const ttl = Number(command.headers.get('nats-ttl') ?? '0');
    const now = this.#clock.now().getTime();
    this.#messages.set(command.subject, {
      subject: command.subject,
      payload: command.payload,
      headers: command.headers,
      seq: this.#seq,
      writtenAt: now,
      expiresAt: ttl > 0 ? now + ttl * 1_000 : undefined,
    });
    this.#reply(command, { stream: 'KV', seq: this.#seq });
  }

  #live(): readonly StoredMessage[] {
    const now = this.#clock.now().getTime();
    const live: StoredMessage[] = [];
    for (const message of this.#messages.values()) {
      if (message.expiresAt !== undefined && message.expiresAt <= now) {
        this.#messages.delete(message.subject);
        continue;
      }
      if (message.headers.get('kv-operation') === undefined) live.push(message);
    }
    return live;
  }

  #headersFor(message: StoredMessage, extra: readonly (readonly [string, string])[]): NatsHeaders {
    return new Map<string, string>([
      ['Nats-Stream', 'KV'],
      ['Nats-Subject', message.subject],
      ['Nats-Sequence', String(message.seq)],
      ['Nats-Time-Stamp', new Date(message.writtenAt).toISOString()],
      ...(message.headers.get('kv-operation') === undefined
        ? []
        : ([['KV-Operation', message.headers.get('kv-operation') ?? '']] as const)),
      ...extra,
    ]);
  }

  #jetStream(command: Extract<ClientCommand, { kind: 'pub' }>): void {
    const subject = command.subject;
    if (subject.startsWith('$JS.API.STREAM.INFO.')) {
      const name = subject.slice('$JS.API.STREAM.INFO.'.length);
      const config = this.#streams.get(name);
      this.#reply(
        command,
        config === undefined
          ? { error: { code: 404, err_code: 10_059, description: 'stream not found' } }
          : { config },
      );
      return;
    }
    if (subject.startsWith('$JS.API.STREAM.CREATE.')) {
      const name = subject.slice('$JS.API.STREAM.CREATE.'.length);
      const config: unknown = JSON.parse(command.payload || '{}');
      this.#streams.set(name, config as Record<string, unknown>);
      this.#reply(command, { config });
      return;
    }
    if (subject.startsWith('$JS.API.DIRECT.GET.')) {
      this.#directGet(command, subject.slice('$JS.API.DIRECT.GET.'.length));
      return;
    }
    this.#reply(command, {
      error: { code: 503, err_code: 0, description: `no responder for ${subject}` },
    });
  }

  /** `…GET.<stream>.<subject>` is one key; `…GET.<stream>` with a `multi_last` body is a batch. */
  #directGet(command: Extract<ClientCommand, { kind: 'pub' }>, tail: string): void {
    const reply = command.replyTo;
    if (reply === undefined) return;
    const dot = tail.indexOf('.');
    if (dot >= 0) {
      const wanted = tail.slice(dot + 1);
      const found = this.#live().find((message) => message.subject === wanted);
      const stale = this.#messages.get(wanted);
      if (found === undefined && stale === undefined) {
        this.#route(reply, '', undefined, new Map(), '404 Message Not Found');
        return;
      }
      const message = found ?? stale;
      if (message === undefined) return;
      this.#route(reply, message.payload, undefined, this.#headersFor(message, []));
      return;
    }
    const body: unknown = JSON.parse(command.payload || '{}');
    const filters = (body as { multi_last?: unknown }).multi_last;
    const patterns = Array.isArray(filters) ? filters.filter((f) => typeof f === 'string') : [];
    const matched = [...this.#messages.values()].filter(
      (message) =>
        patterns.some((pattern) => subjectMatches(pattern, message.subject)) &&
        !(message.expiresAt !== undefined && message.expiresAt <= this.#clock.now().getTime()),
    );
    if (matched.length === 0) {
      this.#route(reply, '', undefined, new Map(), '404 No Results');
      return;
    }
    matched.forEach((message, index) => {
      const pending = String(matched.length - index - 1);
      this.#route(
        reply,
        message.payload,
        undefined,
        this.#headersFor(message, [['Nats-Num-Pending', pending]]),
      );
    });
    this.#route(reply, '', undefined, new Map([['Nats-Num-Pending', '0']]), '204 EOB');
  }
}

/** One connected client stream against a fresh server — the one-liner most tests want. */
export const fakeNatsStream = (server: FakeNatsServer): NatsStream => server.connect();
