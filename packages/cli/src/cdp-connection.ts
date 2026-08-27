// One responsibility: a Chrome DevTools Protocol connection over Bun's own WebSocket — request
// framing, response correlation, and the per-call deadline. Launching a browser is `cdp-launch.ts`
// and the page surface is `cdp-e2e-page.ts`; this file knows nothing about either.
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

export interface CdpConnectionOptions {
  readonly endpoint: string;
  /** Per-call deadline. A CDP call that never answers is a suite that never finishes. */
  readonly timeoutMs: number;
}

export async function cdpConnect(options: CdpConnectionOptions): Promise<CdpConnection> {
  assert(
    options.endpoint.startsWith('ws://') || options.endpoint.startsWith('wss://'),
    `the CDP endpoint is ${options.endpoint === '' ? 'empty' : 'not a WebSocket url'}`,
    'pass the `webSocketDebuggerUrl` Chrome prints on stderr, or the one /json/version answers',
  );
  const socket = new WebSocket(options.endpoint);
  const pending = new Map<number, Pending>();
  const waiters = new Set<(method: string, sessionId: string | undefined) => void>();
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

  socket.onmessage = (event: MessageEvent): void => {
    const raw = typeof event.data === 'string' ? event.data : '';
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
  socket.onclose = (): void => abandon('the browser closed the CDP connection');
  socket.onerror = (): void => abandon('the CDP connection failed');

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
  socket.onerror = (): void => abandon('the CDP connection failed');

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
          reject(new CdpTimeoutError({ method, timeoutMs: options.timeoutMs }));
        }, options.timeoutMs);
        pending.set(id, { resolve, reject, timer });
        socket.send(
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
    close(): void {
      abandon('the driver closed the CDP connection');
      socket.close();
    },
  };
}
