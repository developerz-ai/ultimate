// The page's one socket, built the way a browser builds it: no seated client, so `pageSocket` makes
// one over the in-page host (no `SharedWorker` here) and the engine dials a fake `WebSocket`. What
// is proven is the wiring — one client per page, the dial after the disk boot, a redial under a new
// principal, and the refusal when nothing says where the node is.

import { afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { pageClient, rescope } from '@ultimat3/core/page';
import { resetPage, signal } from './hooks-fixture';
import { hasPageSocket, pageSocket, resetPageSocket } from './page-socket';
import { BOOT_KEY, type BootHost, pageRealtime } from './page-store';
import { installRealtime } from './reactivity';

class FakeWebSocket {
  static opened: FakeWebSocket[] = [];
  readonly closes: (number | undefined)[] = [];
  readonly sent: string[] = [];
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.opened.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closes.push(code);
  }
}

/** Unroutable on purpose: whatever happens, a case never reaches a real node. */
const TARGET = { url: 'ws://127.0.0.1:9/_x/sync', buildId: 'b1' };
const realWebSocket = globalThis.WebSocket;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * Waits for `check` to hold, then answers — never a fixed number of ticks. Every step here crosses
 * a `MessageChannel` (tab → engine → tab), whose delivery is a task the runtime schedules when it
 * can: 5 ms was enough on a laptop and not on a loaded 4-core runner with coverage on.
 */
async function until(check: () => boolean): Promise<void> {
  for (let waited = 0; waited < 2_000 && !check(); waited += 5) await settle();
}

afterEach(() => {
  resetPageSocket();
  resetPage();
  globalThis.WebSocket = realWebSocket;
  FakeWebSocket.opened = [];
});

function browserPage(sync: typeof TARGET | undefined): void {
  resetPage();
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  installRealtime(sync === undefined ? { signal } : { signal, sync });
}

describe('pageSocket', () => {
  test('with no sync target anywhere it refuses, naming the hook that asked', () => {
    browserPage(undefined);
    let caught: unknown;
    try {
      pageSocket('useChannel');
    } catch (error) {
      caught = error;
    }
    expect(isUltimateError(caught) && caught.code).toBe('X_SYNC_UNCONFIGURED');
    expect(isUltimateError(caught) && caught.cause).toContain('useChannel()');
    expect(hasPageSocket()).toBe(false);
  });

  test('one client per page, seated where every bundle finds it, dialled once the boot is done', async () => {
    browserPage(TARGET);
    let boot: () => void = () => undefined;
    (globalThis as BootHost)[BOOT_KEY] = new Promise<void>((resolve) => {
      boot = resolve;
    });
    const client = pageSocket('useConnection');
    expect(pageSocket('useRecord')).toBe(client);
    expect(pageRealtime().socket).toBe(client);
    expect(pageClient().socket).toBe(client);
    expect(hasPageSocket()).toBe(true);

    await settle();
    expect(FakeWebSocket.opened).toEqual([]); // the disk restore has not landed yet
    boot();
    await until(() => FakeWebSocket.opened.length > 0);
    expect(FakeWebSocket.opened.map((ws) => ws.url)).toEqual([`${TARGET.url}?build=b1`]);

    FakeWebSocket.opened[0]?.onopen?.();
    await until(() => client.connected);
    expect(client.connected).toBe(true);
  });

  test('pagehide says bye: the page socket is closed with the tab', async () => {
    browserPage(TARGET);
    pageSocket('useConnection');
    await until(() => FakeWebSocket.opened.length > 0);
    dispatchEvent(new Event('pagehide'));
    await until(() => (FakeWebSocket.opened[0]?.closes.length ?? 0) > 0);
    expect(FakeWebSocket.opened[0]?.closes).toEqual([1000]);
  });

  test('a new principal leaves the old socket and dials a fresh one', async () => {
    browserPage(TARGET);
    const client = pageSocket('useConnection');
    await until(() => FakeWebSocket.opened.length > 0);
    FakeWebSocket.opened[0]?.onopen?.();
    await until(() => client.connected);
    expect(client.connected).toBe(true);

    rescope(`${pageClient().scope.principal ?? 'nobody'}-next`);
    await until(
      () => FakeWebSocket.opened.length >= 2 && (FakeWebSocket.opened[0]?.closes.length ?? 0) > 0,
    );
    await settle(); // and nothing further: exactly one redial, never two
    expect(FakeWebSocket.opened[0]?.closes).toEqual([1000]);
    expect(FakeWebSocket.opened).toHaveLength(2);
  });
});
