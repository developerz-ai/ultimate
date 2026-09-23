// What one shot page saw: its console, its uncaught exceptions and its requests, each in a BOUNDED
// tail with a count of what the bound threw away. And the allow list, enforced in the browser:
// every request is paused (`Fetch.requestPaused`) and refused unless its host is allowed, so an
// injected `<img src="http://169.254.169.254/…">` never leaves — it is recorded as `refused`.
import { hostDecision } from '@ultimat3/core';
import type { CdpConnection } from '@ultimat3/testing';
import type {
  ConsoleLine,
  NetworkEntry,
  PageError,
  ShotClock,
  ShotResourceType,
} from './browser-launcher-port';

export const SHOT_RING_CAPACITY = 200;

/** One `PageError` field's cap: one stack overflow's trace is thousands of frames. */
export const MAX_PAGE_ERROR_CHARS = 4_000;

const clamped = (text: string): string =>
  text.length <= MAX_PAGE_ERROR_CHARS ? text : `${text.slice(0, MAX_PAGE_ERROR_CHARS - 1)}…`;

/** A bounded, keyed tail: the oldest entry goes first, and every one that goes is counted. */
class Tail<T> {
  readonly #items = new Map<string, T>();
  #dropped = 0;
  #next = 0;

  put(value: T, key = `#${String(this.#next++)}`): void {
    this.#items.set(key, value);
    while (this.#items.size > SHOT_RING_CAPACITY) {
      const oldest = this.#items.keys().next().value;
      if (oldest === undefined) break;
      this.#items.delete(oldest);
      this.#dropped += 1;
    }
  }
  get(key: string): T | undefined {
    return this.#items.get(key);
  }
  /** Move the entry under `key` to a key of its own at the end, freeing `key` for its successor. */
  retire(key: string): void {
    const held = this.#items.get(key);
    if (held === undefined) return;
    this.#items.delete(key);
    this.put(held);
  }
  /** Re-set in place: `Map.set` on a present key keeps its position. */
  update(key: string, value: T): void {
    if (this.#items.has(key)) this.#items.set(key, value);
  }
  entries = (): readonly T[] => [...this.#items.values()];
  dropped = (): number => this.#dropped;
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const LEVELS: ReadonlyMap<string, ConsoleLine['level']> = new Map([
  ['warning', 'warn'],
  ['error', 'error'],
  ['assert', 'error'],
  ['debug', 'debug'],
  ['info', 'info'],
]);

const RESOURCE_TYPES: ReadonlyMap<string, ShotResourceType> = new Map([
  ['Document', 'document'],
  ['Stylesheet', 'stylesheet'],
  ['Image', 'image'],
  ['Media', 'media'],
  ['Font', 'font'],
  ['Script', 'script'],
  ['XHR', 'xhr'],
  ['Fetch', 'fetch'],
  ['WebSocket', 'websocket'],
]);

const resourceType = (type: unknown): ShotResourceType =>
  RESOURCE_TYPES.get(text(type) ?? '') ?? 'other';

/** A console argument as the line a reader is shown: a value, else what the browser described. */
const argText = (arg: unknown): string => {
  const remote = record(arg);
  const value = remote?.['value'];
  if (typeof value === 'string') return value;
  if (value !== undefined) return JSON.stringify(value) ?? '';
  return text(remote?.['unserializableValue']) ?? text(remote?.['description']) ?? '';
};

/** `Runtime.exceptionThrown`'s details as a `PageError`: message without its `Name: `, stack whole. */
export const pageErrorOf = (params: Readonly<Record<string, unknown>>, at: number): PageError => {
  const details = record(params['exceptionDetails']);
  const exception = record(details?.['exception']);
  const description = text(exception?.['description']);
  if (description === undefined) {
    const thrown = exception?.['value'];
    const message = thrown === undefined ? (text(details?.['text']) ?? '') : String(thrown);
    return { message: clamped(message), at };
  }
  const first = description.split('\n')[0] ?? '';
  const name = text(exception?.['className']);
  const message =
    name !== undefined && first.startsWith(`${name}: `) ? first.slice(name.length + 2) : first;
  const stack = description.includes('\n') ? clamped(description) : undefined;
  return { message: clamped(message), ...(stack === undefined ? {} : { stack }), at };
};

export interface PageWatch {
  console(): readonly ConsoleLine[];
  pageErrors(): readonly PageError[];
  pageErrorsDropped(): number;
  network(): readonly NetworkEntry[];
  networkDropped(): number;
  /** Stop listening. Idempotent. */
  stop(): void;
}

/**
 * Subscribe BEFORE the domains are enabled (the caller's order), so the first request of the first
 * navigation is already counted. Only events on `sessionId` are read: a remote browser carries
 * other people's pages.
 */
export function watchPage(input: {
  readonly connection: CdpConnection;
  readonly sessionId: string;
  readonly clock: ShotClock;
  readonly allowHosts: readonly string[];
}): PageWatch {
  const { connection, sessionId } = input;
  const lines = new Tail<ConsoleLine>();
  const errors = new Tail<PageError>();
  const requests = new Tail<NetworkEntry>();
  const now = (): number => input.clock.now().getTime();
  const mine =
    (listener: (params: Readonly<Record<string, unknown>>) => void) =>
    (params: Record<string, unknown>, on: string | undefined): void => {
      if (on === sessionId) listener(params);
    };

  const offs = [
    connection.on(
      'Runtime.consoleAPICalled',
      mine((params) => {
        const args = params['args'];
        lines.put({
          level: LEVELS.get(text(params['type']) ?? '') ?? 'log',
          text: (Array.isArray(args) ? args : []).map(argText).join(' '),
          at: now(),
        });
      }),
    ),
    connection.on(
      'Runtime.exceptionThrown',
      mine((params) => errors.put(pageErrorOf(params, now()))),
    ),
    connection.on(
      'Network.requestWillBeSent',
      mine((params) => {
        const id = text(params['requestId']) ?? '';
        const request = record(params['request']);
        const held = requests.get(id);
        const entry: NetworkEntry = {
          method: text(request?.['method']) ?? 'GET',
          url: text(request?.['url']) ?? '',
          resourceType: resourceType(params['type']),
          at: now(),
          ...(held?.refused === undefined ? {} : { refused: held.refused }),
        };
        // A redirect re-sends under the SAME id: the hop before it is a request of its own,
        // answered with the redirect's status.
        const hop = record(params['redirectResponse'])?.['status'];
        if (held !== undefined && held.refused === undefined && typeof hop === 'number') {
          requests.update(id, { ...held, status: hop });
          requests.retire(id);
          requests.put(entry, id);
        } else if (held === undefined) requests.put(entry, id);
        else requests.update(id, entry);
      }),
    ),
    connection.on(
      'Network.responseReceived',
      mine((params) => {
        const id = text(params['requestId']) ?? '';
        const status = record(params['response'])?.['status'];
        const held = requests.get(id);
        if (held !== undefined && typeof status === 'number')
          requests.update(id, { ...held, status });
      }),
    ),
    connection.on(
      'Fetch.requestPaused',
      mine((params) => {
        const pausedId = text(params['requestId']) ?? '';
        const request = record(params['request']);
        const url = text(request?.['url']) ?? '';
        if (hostDecision(url, input.allowHosts).allowed) {
          void connection
            .send('Fetch.continueRequest', { requestId: pausedId }, sessionId)
            .catch(() => undefined);
          return;
        }
        const id = text(params['networkId']) ?? pausedId;
        const held = requests.get(id);
        const refused: NetworkEntry = {
          method: text(request?.['method']) ?? held?.method ?? 'GET',
          url,
          resourceType: resourceType(params['resourceType']),
          at: held?.at ?? now(),
          refused: 'host',
        };
        if (held === undefined) requests.put(refused, id);
        else requests.update(id, refused);
        void connection
          .send(
            'Fetch.failRequest',
            { requestId: pausedId, errorReason: 'BlockedByClient' },
            sessionId,
          )
          .catch(() => undefined);
      }),
    ),
  ];

  let stopped = false;
  return {
    console: () => lines.entries(),
    pageErrors: () => errors.entries(),
    pageErrorsDropped: () => errors.dropped(),
    network: () => requests.entries(),
    networkDropped: () => requests.dropped(),
    stop(): void {
      if (stopped) return;
      stopped = true;
      for (const off of offs) off();
    },
  };
}
