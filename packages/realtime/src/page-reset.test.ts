// The one test reset of a page: what an app's island test calls between cases instead of reaching
// into `Symbol.for('ultimate.realtime')`. It acts on `globalThis`, because the socket an island
// test must close was built by the CHUNK's copy of this package, never the test's.

import { afterEach, describe, expect, test } from 'bun:test';
import { pageClient } from '@ultimat3/core/page';
import { FakeSocket, signal } from './hooks-fixture';
import { resetPageRealtime } from './index';
import { OUTBOX_KEY } from './outbox-slot';
import { installPageRuntime } from './page-runtime';
import { hasPageSocket, pageSocket, resetPageSocket } from './page-socket';
import { BOOT_KEY, BOOT_RELEASE_KEY, pageRealtime, peekPageRealtime } from './page-store';
import { installRealtime } from './reactivity';

const TARGET = { url: 'ws://127.0.0.1:9/_x/sync', buildId: 'b1' };

afterEach(() => {
  resetPageRealtime();
});

/** A page whose socket dials a fake through a host of this case's own; answers its byes. */
function pageWithSocket(): { readonly byes: () => number } {
  let byes = 0;
  resetPageSocket({
    openHost: () => ({
      kind: 'in-page',
      socket: () => new FakeSocket(),
      bye: () => {
        byes += 1;
      },
    }),
  });
  installPageRuntime();
  installRealtime({ signal, sync: TARGET });
  pageSocket('useQuery');
  return { byes: () => byes };
}

describe('resetPageRealtime', () => {
  test('closes the page socket and drops every page global the realtime client keeps', () => {
    const { byes } = pageWithSocket();
    const host = globalThis as Record<symbol, unknown>;
    host[OUTBOX_KEY] = { ready: Promise.resolve() };
    Object.defineProperty(host, BOOT_KEY, { value: Promise.resolve(), configurable: true });
    Object.defineProperty(host, BOOT_RELEASE_KEY, { value: () => undefined, configurable: true });
    expect(hasPageSocket()).toBe(true);
    // Published where another bundle's copy of this package can reach it.
    expect(peekPageRealtime()?.closeSocket).toBeTypeOf('function');

    resetPageRealtime();

    expect(byes()).toBe(1);
    expect(peekPageRealtime()).toBeUndefined();
    for (const key of [OUTBOX_KEY, BOOT_KEY, BOOT_RELEASE_KEY]) expect(host[key]).toBeUndefined();
    expect(pageClient().store).toBeUndefined();
    expect(pageClient().socket).toBeUndefined();
  });

  // What an app's island test has: the socket was built by the chunk's own copy of this package,
  // whose module state the test cannot see — only the page object both copies share.
  test("closes a socket another bundle's copy built, through the page object", () => {
    installPageRuntime();
    let closed = 0;
    pageRealtime().closeSocket = () => {
      closed += 1;
    };

    resetPageRealtime();

    expect(closed).toBe(1);
    expect(peekPageRealtime()).toBeUndefined();
  });

  test('is safe on a page nothing touched, and twice', () => {
    resetPageRealtime();
    resetPageRealtime();
    expect(peekPageRealtime()).toBeUndefined();
  });
});
