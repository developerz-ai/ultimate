// The page's one socket, built the way a browser builds it. What `pageSocket` owns is the wiring —
// one client per page, a host per principal, the dial after the disk boot, a redial under a new
// principal, bye on `pagehide`, and the refusal when nothing says where the node is — so those
// cases count HOSTS through a host of their own, synchronously, and never the dials of whatever
// engines the process has alive. One case goes through the real in-page engine end to end.

import { afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { pageClient, rescope } from '@ultimat3/core/page';
import { FakeSocket, resetPage, signal } from './hooks-fixture';
import { hasPageSocket, pageSocket, resetPageSocket } from './page-socket';
import { BOOT_KEY, type BootHost, pageRealtime } from './page-store';
import { installRealtime } from './reactivity';
import type { SocketHost, SocketHostOptions } from './socket-host';

/** Unroutable on purpose: whatever happens, a case never reaches a real node. */
const TARGET = { url: 'ws://127.0.0.1:9/_x/sync', buildId: 'b1' };

interface CountedHost {
  readonly scope: string | null;
  readonly sockets: FakeSocket[];
  byes: number;
}

/** Hosts built for THIS case only: what pageSocket asked for, per principal, and nothing else. */
function countedHosts(): {
  readonly hosts: CountedHost[];
  readonly openHost: (options: SocketHostOptions) => SocketHost;
} {
  const hosts: CountedHost[] = [];
  return {
    hosts,
    openHost: (options) => {
      const counted: CountedHost = { scope: options.scope, sockets: [], byes: 0 };
      hosts.push(counted);
      return {
        kind: 'in-page',
        socket: () => {
          const socket = new FakeSocket();
          counted.sockets.push(socket);
          return socket;
        },
        bye: () => {
          counted.byes += 1;
        },
      };
    },
  };
}

/** A microtask chain settles: `booted.then(connect)` is promise work, never a timer. */
const microtasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

afterEach(() => {
  resetPageSocket();
  resetPage();
});

function browserPage(sync: typeof TARGET | undefined): void {
  resetPage();
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
    const { hosts, openHost } = countedHosts();
    resetPageSocket({ openHost });
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
    expect(hosts).toHaveLength(1);

    await microtasks();
    expect(hosts[0]?.sockets).toEqual([]); // the disk restore has not landed yet
    boot();
    await microtasks();
    expect(hosts[0]?.sockets).toHaveLength(1);
    hosts[0]?.sockets[0]?.open();
    expect(client.connected).toBe(true);
  });

  test('pagehide says bye to the host', async () => {
    const { hosts, openHost } = countedHosts();
    resetPageSocket({ openHost });
    browserPage(TARGET);
    pageSocket('useConnection');
    dispatchEvent(new Event('pagehide'));
    expect(hosts.map((host) => host.byes)).toEqual([1]);
  });

  test('a new principal leaves the old host and dials exactly once on a host of its own', async () => {
    const { hosts, openHost } = countedHosts();
    resetPageSocket({ openHost });
    browserPage(TARGET);
    const client = pageSocket('useConnection');
    await microtasks();
    hosts[0]?.sockets[0]?.open();
    expect(client.connected).toBe(true);

    const next = `${pageClient().scope.principal ?? 'nobody'}-next`;
    rescope(next);
    expect(hosts.map((host) => [host.scope, host.byes, host.sockets.length])).toEqual([
      [hosts[0]?.scope ?? null, 1, 1],
      [next, 0, 1],
    ]);
    hosts[1]?.sockets[0]?.open();
    expect(client.connected).toBe(true);
  });
});

describe('pageSocket over the real in-page engine', () => {
  class FakeWebSocket {
    static opened: FakeWebSocket[] = [];
    readonly closes: (number | undefined)[] = [];
    bufferedAmount = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    constructor(readonly url: string) {
      FakeWebSocket.opened.push(this);
    }
    send(): void {}
    close(code?: number): void {
      this.closes.push(code);
    }
  }
  const realWebSocket = globalThis.WebSocket;
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));
  /** A `MessageChannel` hop is a task, not a promise: wait for the condition, never a tick count. */
  async function until(check: () => boolean): Promise<void> {
    for (let waited = 0; waited < 2_000 && !check(); waited += 5) await settle();
  }

  afterEach(() => {
    globalThis.WebSocket = realWebSocket;
    FakeWebSocket.opened = [];
  });

  test('the page dials the node at the build-carrying url and comes up when it opens', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    browserPage(TARGET);
    const client = pageSocket('useConnection');
    await until(() => FakeWebSocket.opened.length > 0);
    // The first dial is this page's: asserted by url, never by how many engines the process holds.
    expect(FakeWebSocket.opened[0]?.url).toBe(`${TARGET.url}?build=b1`);
    FakeWebSocket.opened[0]?.onopen?.();
    await until(() => client.connected);
    expect(client.connected).toBe(true);
  });
});
