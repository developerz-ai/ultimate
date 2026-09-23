// The tab side of the page's one socket (plan 101, slice 11): pick the host — a `SharedWorker`
// shared by every tab of this origin and principal, or the in-page engine when there is none —
// and hand the tab's `LiveClient` a socket that is really a `MessagePort`. One engine, one
// protocol, under both hosts: the fallback costs a socket per tab and nothing else.

import { browserSocket, dialUrl } from './browser-socket';
import type { ClientSocket } from './client-contract';
import type { SyncTarget } from './page-store';
import { messagePort, type PortLike, SocketEngine } from './socket-engine';

export interface SocketHostOptions {
  /** The built worker script (`<meta name="ultimate-sync-worker">`); absent = in-page host. */
  readonly workerUrl?: string | undefined;
  /** The principal the page acts for: one worker per principal, never a shared socket across two. */
  readonly scope: string | null;
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

/** The worker's name carries the scope, so two principals in two tabs get two workers. */
export function workerName(scope: string | null): string {
  return `ultimate-sync:${encodeURIComponent(scope ?? '')}`;
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
    return messagePort(new Worker(options.workerUrl, { name: workerName(options.scope) }).port);
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
