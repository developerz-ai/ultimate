// The SharedWorker entry, loaded as the worker loads it: importing it installs `onconnect`, a tab's
// port attaches to the one engine, and the engine dials the real socket at the build-carrying URL.
// A fake `WebSocket` and a real `MessageChannel` stand in for the worker's globals.

import { afterAll, describe, expect, test } from 'bun:test';
import type { PortMessage } from './socket-port';
import { untilTurn } from './turns-fixture';

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

type WorkerScope = { onconnect?: (event: { ports: readonly MessagePort[] }) => void };

const realWebSocket = globalThis.WebSocket;
afterAll(() => {
  globalThis.WebSocket = realWebSocket;
  Reflect.deleteProperty(globalThis, 'onconnect');
});

/** A `MessageChannel` hop is one task (one turn): wait for the condition, never a delay. */
const until = (check: () => boolean): Promise<void> => untilTurn(check, 'the worker round trip');

/**
 * Where the handler the entry installed is kept for a rerun. The entry is evaluated once per
 * process and the `afterAll` above takes the global away, while `--rerun-each` evaluates THIS file
 * again: a rerun imported the cached entry, which installs nothing, and found no `onconnect`.
 */
const INSTALLED = Symbol.for('ultimate.test.sync-worker.onconnect');
const kept = globalThis as { [INSTALLED]?: WorkerScope['onconnect'] };

describe('the sync worker entry', () => {
  test('a connecting tab is attached: its open dials the node, and its bye closes the socket', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    FakeWebSocket.opened = [];
    await import('./sync-worker');
    kept[INSTALLED] ??= (globalThis as WorkerScope).onconnect;
    const scope = { onconnect: kept[INSTALLED] };
    if (scope.onconnect === undefined)
      return expect.unreachable('the entry installed no onconnect');

    const channel = new MessageChannel();
    const heard: PortMessage[] = [];
    channel.port2.onmessage = (event: MessageEvent) => heard.push(event.data as PortMessage);
    scope.onconnect({ ports: [channel.port1] });

    channel.port2.postMessage({
      t: 'open',
      target: { url: 'ws://node.test/_x/sync', buildId: 'b1' },
    });
    await until(() => FakeWebSocket.opened.length > 0);
    // By url, never by count: another engine alive in this process may dial the same fake global.
    expect(FakeWebSocket.opened[0]?.url).toBe('ws://node.test/_x/sync?build=b1');

    FakeWebSocket.opened[0]?.onopen?.();
    await until(() => heard.some((message) => message.t === 'open'));
    expect(heard.map((message) => message.t)).toContain('open');

    channel.port2.postMessage({ t: 'bye' });
    await until(() => (FakeWebSocket.opened[0]?.closes.length ?? 0) > 0);
    expect(FakeWebSocket.opened[0]?.closes).toEqual([1000]);
    channel.port2.close();
  });
});
