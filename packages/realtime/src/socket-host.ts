// The tab side of the page's one socket (plan 101, slice 11): pick the host — a `SharedWorker`
// shared by every tab of this origin and principal, or the in-page engine when there is none —
// and hand the tab's `LiveClient` a socket that is really a `MessagePort`. One engine, one
// protocol, under both hosts: the fallback costs a socket per tab and nothing else.

import { browserSocket, dialUrl } from './browser-socket';
import type { ClientSocket } from './client-contract';
import type { SyncTarget } from './page-store';
import { messagePort, type PortLike, SocketEngine } from './socket-engine';
import { type Scheduler, timeoutScheduler } from './thundering-herd';

export interface SocketHostOptions {
  /** The built worker script (`<meta name="ultimate-sync-worker">`); absent = in-page host. */
  readonly workerUrl?: string | undefined;
  /** The principal the page acts for: one worker per principal, never a shared socket across two. */
  readonly scope: string | null;
  /** The build the page was rendered by: one worker per build, too. See `workerName`. */
  readonly buildId?: string | undefined;
  /** Injected for tests; production reads the globals. */
  readonly sharedWorker?: SharedWorkerLike | undefined;
  readonly inPageEngine?: () => SocketEngine;
}

export type SharedWorkerLike = new (
  url: string,
  options: { name: string },
) => { port: MessagePort };

export interface SocketHost {
  /** `'worker'` or `'in-page'` — which host this page ended up on. */
  readonly kind: 'worker' | 'in-page';
  /** A fresh virtual socket over the port — what `LiveClient`'s `connect` option returns. */
  socket(target: SyncTarget): ClientSocket;
  /** The tab is going away: release the port in the engine. */
  bye(): void;
}

/**
 * The worker's name carries the scope, so two principals in two tabs get two workers — and the
 * BUILD, so two builds do too. A SharedWorker keeps the first tab's build id for its whole life, so
 * a tab of the new build joined the old engine and was told "update available" about itself.
 */
export function workerName(scope: string | null, buildId: string | undefined): string {
  return `ultimate-sync:${encodeURIComponent(scope ?? '')}:${encodeURIComponent(buildId ?? '')}`;
}

export function openHost(options: SocketHostOptions): SocketHost {
  const worker = options.workerUrl === undefined ? undefined : workerPort(options);
  if (worker !== undefined) return hostOver(worker, 'worker');
  const channel = new MessageChannel();
  const engine =
    options.inPageEngine?.() ??
    new SocketEngine({ dial: (target) => browserSocket(dialUrl(target)) });
  engine.attach(messagePort(channel.port1));
  return hostOver(messagePort(channel.port2), 'in-page');
}

/** `undefined` whenever a worker cannot be had — absent, sandboxed, or refused by the browser. */
function workerPort(options: SocketHostOptions): PortLike | undefined {
  const Worker =
    options.sharedWorker ??
    (typeof SharedWorker === 'function' ? (SharedWorker as SharedWorkerLike) : undefined);
  if (Worker === undefined || options.workerUrl === undefined) return undefined;
  try {
    return messagePort(
      new Worker(options.workerUrl, { name: workerName(options.scope, options.buildId) }).port,
    );
  } catch {
    return undefined;
  }
}

function hostOver(port: PortLike, kind: 'worker' | 'in-page'): SocketHost {
  let current: VirtualSocket | null = null;
  port.onmessage = (event) => current?.receive(event.data);
  return {
    kind,
    socket: (target) => {
      current = new VirtualSocket(port, target);
      return current;
    },
    bye: () => {
      current = null;
      port.postMessage({ t: 'bye' });
      port.close?.();
    },
  };
}

/** The tab's socket: one `open`, frames both ways, one `close` — over the host's port. */
class VirtualSocket implements ClientSocket {
  readonly #port: PortLike;
  #open: (() => void) | null = null;
  #message: ((data: string) => void) | null = null;
  #closed: ((code: number) => void) | null = null;
  #live = true;

  constructor(port: PortLike, target: SyncTarget) {
    this.#port = port;
    port.postMessage({ t: 'open', target });
  }

  send(data: string): void {
    if (this.#live) this.#port.postMessage({ t: 'frame', data });
  }

  close(): void {
    if (!this.#live) return;
    this.#live = false;
    this.#port.postMessage({ t: 'close', code: 1000 });
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

  receive(message: unknown): void {
    if (!this.#live || typeof message !== 'object' || message === null) return;
    const typed = message as { t?: unknown; data?: unknown; code?: unknown };
    if (typed.t === 'open') this.#open?.();
    else if (typed.t === 'frame' && typeof typed.data === 'string') this.#message?.(typed.data);
    else if (typed.t === 'close') {
      this.#live = false;
      this.#closed?.(typeof typed.code === 'number' ? typed.code : 1006);
    }
  }
}

/** A host that can be replaced under the page's one client. */
export interface RehostingHost extends SocketHost {
  /** Say bye to the current host and build a new one — the next `socket()` dials through it. */
  rehost(): void;
}

export interface RehostingOptions {
  /** How long a virtual socket may wait for `open` before its host is presumed dead. */
  readonly openTimeoutMs: number;
  readonly schedule?: Scheduler | undefined;
}

/**
 * The page's host, replaceable. A port the engine reaped (a throttled hidden tab), or one the tab
 * itself said `bye` on at `pagehide` before a bfcache restore, is a port nobody reads: the virtual
 * socket over it waited for `open` forever and the tab's realtime was dead until a reload. So an
 * `open` unanswered by `openTimeoutMs` closes that socket (1006, which the client redials on) and
 * re-hosts on a fresh port; `page-socket.ts` also re-hosts on a bfcache `pageshow`.
 */
export function rehosting(make: () => SocketHost, options: RehostingOptions): RehostingHost {
  const schedule = options.schedule ?? timeoutScheduler;
  let current = make();
  const self: RehostingHost = {
    get kind(): 'worker' | 'in-page' {
      return current.kind;
    },
    socket: (target) => {
      const inner = current.socket(target);
      return watchOpen(inner, schedule, options.openTimeoutMs, () => self.rehost());
    },
    bye: () => current.bye(),
    rehost: () => {
      current.bye();
      current = make();
    },
  };
  return self;
}

/** `inner`, with a deadline on its `open`: missed, the host is re-made and the socket closes. */
function watchOpen(
  inner: ClientSocket,
  schedule: Scheduler,
  ms: number,
  rehost: () => void,
): ClientSocket {
  let opened: (() => void) | null = null;
  let closed: ((code: number) => void) | null = null;
  let settled = false;
  const disarm = schedule(() => {
    if (settled) return;
    settled = true;
    rehost();
    closed?.(1006);
  }, ms);
  inner.onOpen(() => {
    if (settled) return;
    settled = true;
    disarm();
    opened?.();
  });
  inner.onClose((code) => {
    if (!settled) {
      settled = true;
      disarm();
    }
    closed?.(code);
  });
  return {
    get bufferedAmount(): number {
      return inner.bufferedAmount ?? 0;
    },
    send: (data) => inner.send(data),
    close: (code, reason) => {
      if (!settled) {
        settled = true;
        disarm();
      }
      inner.close(code, reason);
    },
    onOpen: (handler) => {
      opened = handler;
    },
    onMessage: (handler) => inner.onMessage(handler),
    onClose: (handler) => {
      closed = handler;
    },
  };
}
