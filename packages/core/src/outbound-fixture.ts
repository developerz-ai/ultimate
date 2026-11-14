// TEST-ONLY. The seams an `outbound()` test drives instead of a network and a wall clock: a timer
// a case fires by its delay, a body whose chunks the case releases, and a recording fetch.

import type { DeadlineTimer } from './deadline-signal';
import type { OutboundFetch, OutboundInit } from './outbound-types';

export interface ManualTimer extends DeadlineTimer {
  /** Delays armed and not yet cleared or fired. */
  armed(): readonly number[];
  /** Fire every timer armed with this delay; answers how many fired. */
  fire(ms: number): number;
  /** Resolves once a timer with this delay is armed: a pending body read arms its idle timer. */
  armedWith(ms: number): Promise<void>;
}

export function manualTimer(): ManualTimer {
  const pending = new Map<number, { readonly ms: number; readonly fire: () => void }>();
  const waiting: { readonly ms: number; readonly done: () => void }[] = [];
  let next = 0;
  return {
    set(fire, ms) {
      next += 1;
      pending.set(next, { ms, fire });
      for (const wait of waiting.filter((entry) => entry.ms === ms)) {
        waiting.splice(waiting.indexOf(wait), 1);
        wait.done();
      }
      return next;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
    armed: () => [...pending.values()].map((entry) => entry.ms),
    fire(ms) {
      const due = [...pending].filter(([, entry]) => entry.ms === ms);
      for (const [handle, entry] of due) {
        pending.delete(handle);
        entry.fire();
      }
      return due.length;
    },
    armedWith(ms) {
      if ([...pending.values()].some((entry) => entry.ms === ms)) return Promise.resolve();
      return new Promise((done) => waiting.push({ ms, done }));
    },
  };
}

/** A body the case feeds by hand: `push` a chunk, `end`, or leave it stalled. Counts cancels. */
export function heldBody(): {
  readonly stream: ReadableStream<Uint8Array>;
  push(text: string): void;
  end(): void;
  cancelled(): boolean;
} {
  let control: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      control = controller;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    stream,
    push: (text) => control?.enqueue(new TextEncoder().encode(text)),
    end: () => control?.close(),
    cancelled: () => cancelled,
  };
}

export interface SentCall {
  readonly url: string;
  readonly init: OutboundInit;
}

/** A fetch answering from `answer`, each call recorded with the url and init it was sent. */
export function recordingFetch(
  answer: (call: SentCall, n: number) => Promise<Response> | Response,
): {
  readonly fetch: OutboundFetch;
  readonly calls: SentCall[];
} {
  const calls: SentCall[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return await answer(call, calls.length);
    },
  };
}

/**
 * A fetch that only ends when its signal aborts, rejecting with the signal's reason — at once when
 * it arrives aborted, as the platform's does (a missed `abort` event would hang the case).
 */
export const hangingFetch: OutboundFetch = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init.signal;
    if (signal === null || signal === undefined) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

/** Sleeps recorded, never waited for. */
export function recordedSleep(): {
  readonly sleep: (ms: number) => Promise<void>;
  readonly slept: number[];
} {
  const slept: number[] = [];
  return {
    slept,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  };
}

/** A loopback HTTP proxy that answers `CONNECT` only, routing each target host through `route`. */
export interface ConnectProxy {
  /** `http://127.0.0.1:<port>`, no credentials. */
  readonly origin: string;
  /** Every `CONNECT` target (`host:port`) asked for, in order. */
  readonly targets: readonly string[];
  /** Every `Proxy-Authorization` value a `CONNECT` carried. */
  readonly authorizations: readonly string[];
  stop(): void;
}

interface TunnelState {
  head: string;
  upstream: Awaited<ReturnType<typeof Bun.connect>> | undefined;
  open: boolean;
}

/**
 * Tunnels bytes both ways once the `CONNECT` head arrives; anything else is answered 400. `route`
 * maps a target host (the pinned address) to the loopback host that stands in for it.
 */
export function connectProxy(route: (host: string) => string): ConnectProxy {
  const targets: string[] = [];
  const authorizations: string[] = [];
  const listener = Bun.listen<TunnelState>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        socket.data = { head: '', upstream: undefined, open: false };
      },
      async data(socket, chunk) {
        if (socket.data.open) {
          socket.data.upstream?.write(chunk);
          return;
        }
        socket.data.head += new TextDecoder().decode(chunk);
        const end = socket.data.head.indexOf('\r\n\r\n');
        if (end < 0) return;
        const [line = '', ...fields] = socket.data.head.slice(0, end).split('\r\n');
        const [method, target = ''] = line.split(' ');
        if (method !== 'CONNECT') {
          socket.end('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n');
          return;
        }
        targets.push(target);
        for (const field of fields) {
          const [name = '', ...value] = field.split(':');
          if (name.toLowerCase() === 'proxy-authorization')
            authorizations.push(value.join(':').trim());
        }
        const at = target.lastIndexOf(':');
        socket.data.upstream = await Bun.connect({
          hostname: route(target.slice(0, at).replace(/^\[|\]$/g, '')),
          port: Number(target.slice(at + 1)),
          socket: {
            data: (_upstream, bytes) => {
              socket.write(bytes);
            },
            close: () => {
              socket.end();
            },
            error: () => {
              socket.end();
            },
          },
        });
        socket.data.open = true;
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      },
      close(socket) {
        socket.data.upstream?.end();
      },
    },
  });
  return {
    origin: `http://127.0.0.1:${String(listener.port)}`,
    targets,
    authorizations,
    stop: () => listener.stop(true),
  };
}
