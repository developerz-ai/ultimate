// The ONE `new WebSocket` in the framework. The page opens one socket, through this adapter; an
// island never dials, and neither does an app. Four handlers and a send — the reconnect, the
// backoff and the heartbeat all stay in `LiveClient`, which is why this is the whole adapter.

import type { ClientSocket } from './client-contract';
import type { SyncTarget } from './page-store';

export function browserSocket(url: string): ClientSocket {
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
}

/** `?build=` rides the dial, so a stale tab is told to reload on the socket it opens. */
export function dialUrl(target: SyncTarget): string {
  const joiner = target.url.includes('?') ? '&' : '?';
  return `${target.url}${joiner}build=${encodeURIComponent(target.buildId)}`;
}
