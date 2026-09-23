// The SharedWorker entry, loaded as the worker loads it: importing it installs `onconnect`, a tab's
// port attaches to the one engine, and the engine dials the real socket at the build-carrying URL.
// A fake `WebSocket` and a real `MessageChannel` stand in for the worker's globals.

import { afterAll, describe, expect, test } from 'bun:test';
import type { PortMessage } from './socket-port';

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

/** A MessageChannel delivers a task later; a few turns lets a round trip land. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

/** Waits for `check`, never a fixed tick count: a `MessageChannel` hop is a task, not a promise. */
async function until(check: () => boolean): Promise<void> {
  for (let waited = 0; waited < 2_000 && !check(); waited += 5) await settle();
}

describe('the sync worker entry', () => {
  test('a connecting tab is attached: its open dials the node, and its bye closes the socket', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    await import('./sync-worker');
    const scope = globalThis as WorkerScope;
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
    expect(FakeWebSocket.opened.map((ws) => ws.url)).toEqual(['ws://node.test/_x/sync?build=b1']);

    FakeWebSocket.opened[0]?.onopen?.();
    await until(() => heard.some((message) => message.t === 'open'));
    expect(heard.map((message) => message.t)).toContain('open');

    channel.port2.postMessage({ t: 'bye' });
    await until(() => (FakeWebSocket.opened[0]?.closes.length ?? 0) > 0);
    expect(FakeWebSocket.opened[0]?.closes).toEqual([1000]);
    channel.port2.close();
  });
});
