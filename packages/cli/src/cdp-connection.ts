// One responsibility: a Chrome DevTools Protocol connection — request framing, response
// correlation, and the per-call deadline — over a TRANSPORT that moves whole messages. Two exist:
// the pipe a launched Chrome is driven over (`cdp-pipe.ts`, what the e2e driver uses) and a remote
// browser's WebSocket (`cdpConnect` below). Launching is `cdp-launch.ts`; the page surface is
// `cdp-e2e-page.ts`; this file knows nothing about either.
//
// **No library, and that is the point rather than an economy.** `packages/scraping/src/cdp-port.ts`
// declares a ~25-method port because `ScrapePage` is a full scraping surface, and its intended
// implementation is `puppeteer-core`. `E2eBrowserPage` is FIVE methods, and CDP's wire format is
// one JSON object with an `id` — so the whole thing an e2e driver needs is this file plus two
// small ones, on Bun's native `WebSocket`, with no dependency to add to a repo whose first
// non-negotiable is that Bun's natives replace most of them.

import { assert } from '@ultimat3/core';
import { CdpCallFailedError, CdpTimeoutError } from './cdp-errors';

/** One CDP result. `unknown` because every payload here is somebody else's JSON. */
export interface CdpResult {
  readonly result?: Record<string, unknown> | undefined;
}

export interface CdpConnection {
  /** Send one command. `sessionId` targets an attached page rather than the browser itself. */
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<CdpResult>;
  /**
   * Wait for the next occurrence of one CDP **event**, or for the deadline. Answers `true` when the
   * event arrived and `false` when it did not — it never throws, because every caller has a better
   * assertion to fail on than "the event was late".
   *
   * It exists because a command's reply is not always the signal. `Page.navigate`'s reply is
   * DROPPED whenever the navigation swaps the render process — measured on Chrome 150: the page
   * loads, the server is hit, a later `Runtime.evaluate` answers, and the navigate frame never
   * comes back at all. A driver that treated the reply as the completion signal waits out its full
   * deadline on the most ordinary navigation there is.
   */
  once(method: string, sessionId: string | undefined, timeoutMs: number): Promise<boolean>;
  /**
   * Subscribe to every occurrence of one CDP event, until the returned function is called.
   *
   * `once` cannot express what this is for: a target that attaches AFTER the driver stopped
   * listening is a service worker whose network conditions nobody set, which is an `offline()`
   * that silently does nothing to the one thing serving the page.
   */
  on(method: string, listener: (params: Record<string, unknown>) => void): () => void;
  close(): void;
}

interface Pending {
  readonly resolve: (value: CdpResult) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** A CDP error frame: `{ error: { code, message } }`, both fields somebody else's. */
const errorText = (frame: Record<string, unknown>): string | undefined => {
  const error = frame['error'];
  if (typeof error !== 'object' || error === null) return undefined;
  const message = (error as Record<string, unknown>)['message'];
  return typeof message === 'string' ? message : 'the browser refused the call';
};

/**
 * What a connection needs of the wire: whole messages out, whole messages in, and a close. Framing
 * is the transport's — a WebSocket frames per message, the pipe splits on NUL — so correlation and
 * deadlines are written once, over either.
 */
export interface CdpTransport {
  send(text: string): void;
  close(): void;
  /** Installed exactly once, by the connection, before the first `send`. */
  listen(handlers: {
    readonly message: (text: string) => void;
    readonly closed: (reason: string) => void;
  }): void;
}

export interface CdpConnectionOptions {
  readonly endpoint: string;
  /** Per-call deadline. A CDP call that never answers is a suite that never finishes. */
  readonly timeoutMs: number;
}

/**
 * A remote browser over its WebSocket url. NOT the e2e driver's wire: measured in the dummy's
 * `offline-feed` suite on Bun 1.4.0, Bun's WebSocket client handed `onmessage` text spliced out of
 * several frames — 64 unparseable frames in one run, one of them the reply to a `Runtime.evaluate`
 * that then waited out its whole deadline. A launched Chrome is driven over `cdp-pipe.ts` instead.
 */
export async function cdpConnect(options: CdpConnectionOptions): Promise<CdpConnection> {
  assert(
    options.endpoint.startsWith('ws://') || options.endpoint.startsWith('wss://'),
    `the CDP endpoint is ${options.endpoint === '' ? 'empty' : 'not a WebSocket url'}`,
    'pass the `webSocketDebuggerUrl` Chrome prints on stderr, or the one /json/version answers',
  );
  const socket = new WebSocket(options.endpoint);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new CdpTimeoutError({ method: 'connect', timeoutMs: options.timeoutMs }));
    }, options.timeoutMs);
    socket.onopen = (): void => {
      clearTimeout(timer);
      resolve();
    };
    // `onerror` is replaced for the handshake only, then restored above: a failure BEFORE open has
    // no pending call to abandon, and rejecting is the only way the caller hears about it.
    socket.onerror = (): void => {
      clearTimeout(timer);
      reject(
        new CdpCallFailedError({ method: 'connect', detail: 'the browser refused the connection' }),
      );
    };
  });

  const transport: CdpTransport = {
    send: (text) => socket.send(text),
    close: () => socket.close(),
    listen(handlers) {
      socket.onmessage = (event: MessageEvent): void => {
        handlers.message(typeof event.data === 'string' ? event.data : '');
      };
      socket.onclose = (): void => handlers.closed('the browser closed the CDP connection');
      socket.onerror = (): void => handlers.closed('the CDP connection failed');
    },
  };
  return cdpConnectOver(transport, options.timeoutMs);
}

/** A connection over any transport — correlation, deadlines and events, written once. */
export function cdpConnectOver(transport: CdpTransport, timeoutMs: number): CdpConnection {
  const pending = new Map<number, Pending>();
  const waiters = new Set<(method: string, sessionId: string | undefined) => void>();
  const listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  let nextId = 0;
  let closed = false;

  // Every in-flight call is settled on close. Without this a suite whose browser died waits out
  // one full deadline per call and reports a timeout, where the true fault is a dead browser.
  const abandon = (reason: string): void => {
    closed = true;
    for (const [, one] of pending) {
      clearTimeout(one.timer);
      one.reject(new CdpCallFailedError({ method: 'the connection', detail: reason }));
    }
    pending.clear();
    // A waiter is a "did this happen" question, and on a dead connection the answer is no. Its
    // own timer settles it, so nothing is left hanging; clearing the set only stops a late frame
    // from resolving a waiter whose connection has gone.
    waiters.clear();
  };

  const message = (raw: string): void => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // An unparseable frame is the browser's, not ours, and there is no call to fail with it:
      // correlation is by `id`, and a frame we cannot read has none. Events land here too.
      return;
    }
    const id = frame['id'];
    if (typeof id !== 'number') {
      const method = frame['method'];
      if (typeof method !== 'string') return;
      const on = frame['sessionId'];
      for (const waiter of [...waiters]) waiter(method, typeof on === 'string' ? on : undefined);
      const subscribed = listeners.get(method);
      if (subscribed !== undefined) {
        const params = frame['params'];
        const payload: Record<string, unknown> =
          typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
        // A copy, because a listener may unsubscribe itself while this loop is running.
        for (const listener of [...subscribed]) listener(payload);
      }
      return;
    }
    const one = pending.get(id);
    if (one === undefined) return;
    pending.delete(id);
    clearTimeout(one.timer);
    const failed = errorText(frame);
    if (failed !== undefined) {
      one.reject(new CdpCallFailedError({ method: `call ${String(id)}`, detail: failed }));
      return;
    }
    const result = frame['result'];
    one.resolve({
      result:
        typeof result === 'object' && result !== null
          ? (result as Record<string, unknown>)
          : undefined,
    });
  };
  transport.listen({ message, closed: abandon });

  return {
    send(method, params = {}, sessionId): Promise<CdpResult> {
      if (closed) {
        return Promise.reject(
          new CdpCallFailedError({ method, detail: 'the CDP connection is already closed' }),
        );
      }
      nextId += 1;
      const id = nextId;
      return new Promise<CdpResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new CdpTimeoutError({ method, timeoutMs: timeoutMs }));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        transport.send(
          JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }),
        );
      });
    },
    once(method, sessionId, timeoutMs): Promise<boolean> {
      if (closed) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const waiter = (seen: string, on: string | undefined): void => {
          if (seen !== method) return;
          if (sessionId !== undefined && on !== sessionId) return;
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve(true);
        };
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          resolve(false);
        }, timeoutMs);
        waiters.add(waiter);
      });
    },
    on(method, listener): () => void {
      const subscribed = listeners.get(method) ?? new Set();
      subscribed.add(listener);
      listeners.set(method, subscribed);
      return () => {
        subscribed.delete(listener);
        if (subscribed.size === 0) listeners.delete(method);
      };
    },
    close(): void {
      listeners.clear();
      abandon('the driver closed the CDP connection');
      transport.close();
    },
  };
}
