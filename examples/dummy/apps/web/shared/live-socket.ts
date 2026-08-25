/**
 * The two browser primitives every island holding a `LiveClient` has to supply it: a real
 * `WebSocket` as the framework's `ClientSocket`, and Solid's `createSignal` narrowed to the
 * factory realtime declares.
 *
 * `shared/`, not a feature, and not a copy per island: `/feed` carried both inline until
 * `/posts/{id}` grew an island of its own, and two adapters over one socket API is two places to
 * fix the next backpressure bug in.
 */

import type { ClientSocket, SignalFactory } from '@ultimat3/realtime';
import { createSignal } from 'solid-js';

/**
 * `WebSocket` as the framework's `ClientSocket`. Four handlers and a send — the reconnect, the
 * backoff and the heartbeat all stay in `LiveClient`, which is why this is the whole adapter.
 */
export const socketFor = (url: string): ClientSocket => {
  const socket = new WebSocket(url);
  return {
    send: (data: string): void => {
      socket.send(data);
    },
    close: (code?: number, reason?: string): void => {
      socket.close(code, reason);
    },
    onOpen: (handler: () => void): void => {
      socket.onopen = (): void => {
        handler();
      };
    },
    onMessage: (handler: (data: string) => void): void => {
      socket.onmessage = (event: MessageEvent): void => {
        handler(String(event.data));
      };
    },
    onClose: (handler: (code: number) => void): void => {
      socket.onclose = (event: CloseEvent): void => {
        handler(event.code);
      };
    },
    get bufferedAmount(): number {
      return socket.bufferedAmount;
    },
  };
};

/**
 * Solid's `createSignal`, narrowed to the two-function shape realtime declares. Wrapped rather
 * than passed: Solid's setter also accepts an updater function, so a `T` that IS a function would
 * be called instead of stored.
 */
export const signal: SignalFactory = <T>(initial: T): [() => T, (next: T) => void] => {
  const [get, set] = createSignal<T>(initial);
  return [
    get,
    (next: T): void => {
      set(() => next);
    },
  ];
};
