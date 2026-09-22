// The doubles the client and hook suites drive: an injected socket, a closure-backed signal, one
// client over the page's record store, and a page reset between cases. Shared rather than copied
// because every suite must exercise the SAME wiring — harnesses that drifted would be clients
// agreeing only by construction. A `-fixture.ts` file is excluded from the package tarball.

import { frozenClock } from '@ultimat3/core';
import { pageClient } from '@ultimat3/core/page';
import { type ClientSocket, LiveClient } from './client';
import type { SignalFactory } from './client-contract';
import { type PageRealtime, pageRealtime } from './page-store';
import { installRealtime, uninstallRealtime } from './reactivity';
import { decode, encode, type Frame } from './sync-protocol';

export type PostRow = {
  readonly id: string;
  readonly likedByMe: boolean;
  readonly likeCount: number;
};

/** Synchronous and closure-backed: enough to prove an accessor re-reads, with no reactive runtime. */
export const signal: SignalFactory = <T>(initial: T) => {
  let value = initial;
  return [
    () => value,
    (next: T) => {
      value = next;
    },
  ];
};

/** The injected socket, driven from the test: `open`/`deliver` are the server's half. */
export class FakeSocket implements ClientSocket {
  readonly sent: string[] = [];
  bufferedAmount = 0;
  #open: (() => void) | null = null;
  #message: ((data: string) => void) | null = null;
  #closed: ((code: number) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    this.#closed?.(code);
  }

  onOpen(handler: () => void): void {
    this.#open = handler;
  }

  onMessage(handler: (data: string) => void): void {
    this.#message = handler;
  }

  onClose(handler: (code: number) => void): void {
    this.#closed = handler;
  }

  open(): void {
    this.#open?.();
  }

  deliver(frame: Frame): void {
    this.#message?.(encode(frame));
  }

  frames(): readonly Frame[] {
    return this.sent.map((data) => decode(data));
  }
}

/** Drop every trace of the previous case's page: its state, its store and its socket. */
export function resetPage(): void {
  uninstallRealtime();
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.realtime'));
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.outbox'));
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.page-boot'));
  const handle = pageClient();
  handle.store = undefined;
  handle.socket = undefined;
}

export interface PageHarness {
  readonly page: PageRealtime;
  readonly client: LiveClient;
  readonly socket: FakeSocket;
  readonly clock: ReturnType<typeof frozenClock>;
  readonly errors: unknown[];
}

/**
 * A browser page as the island bootstrap leaves it: realtime installed with this bundle's signal,
 * and the page socket pre-seated with a client over a fake socket — so `pageSocket()` finds it and
 * never reaches `new WebSocket`.
 */
export function pageHarness(
  options: {
    catchUp?: (query: string, params: Readonly<Record<string, string>>) => Promise<unknown>;
  } = {},
): PageHarness {
  resetPage();
  installRealtime({ signal, sync: { url: 'ws://node.test/_x/sync', buildId: 'build-1' } });
  const page = pageRealtime();
  const socket = new FakeSocket();
  const clock = frozenClock(1_000);
  const errors: unknown[] = [];
  const client = new LiveClient({
    connect: () => socket,
    buildId: 'build-1',
    catchUp: options.catchUp ?? (async () => undefined),
    store: page.store,
    clock,
    rng: () => 0,
    heartbeatMs: 0,
    // Arms nothing: a closed socket must not leave a real `setTimeout` dialling behind the test.
    scheduler: () => () => {},
    onError: (error) => {
      errors.push(error);
    },
  });
  page.socket = client;
  pageClient().socket = client;
  client.connect();
  return { page, client, socket, clock, errors };
}

/** Every sid the client minted for a query subscription, in order — a test never picks one. */
export function querySids(socket: FakeSocket, op: 'add' | 'drop'): readonly string[] {
  const sids: string[] = [];
  for (const frame of socket.frames()) {
    if (frame.type === 'subscribe' && frame.op === op && frame.target.kind === 'query') {
      sids.push(frame.sid);
    }
  }
  return sids;
}

export function querySid(socket: FakeSocket, op: 'add' | 'drop'): string {
  return querySids(socket, op)[0] ?? '';
}

/** Lets a promise chain inside a hook (an HTTP answer) settle before the test reads its state. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export const liveFeed = { name: 'liveFeed', live: true } as const;

/** A `fetch` double: records every request and answers each with the next queued response. */
export function fakeFetch(answers: (() => Response)[]): {
  readonly fetchImpl: (input: string, init: RequestInit) => Promise<Response>;
  readonly calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const next = answers.shift();
      if (next === undefined) return new Response('{}', { status: 500 });
      return next();
    },
  };
}

/** A JSON answer, optionally carrying the records envelope core's transport decodes. */
export function jsonAnswer(body: unknown, enveloped = false): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...(enveloped ? { 'x-ultimate-records': '1' } : {}),
    },
  });
}
