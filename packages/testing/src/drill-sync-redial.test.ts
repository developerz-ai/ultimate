// The sync lane against scripted sockets, on its own sleep: a dropped socket is re-dialled after
// `redialMs`, a frame that is not JSON counts as nothing, and the lane is back only once a `hello`
// has answered it.

import { describe, expect, test } from 'bun:test';
import type { DrillSyncSocket } from './drill-sync';
import { startDrillSync } from './drill-sync';

type Listener = (event: { readonly data: unknown }) => void;

/** A socket the test fires events at; it records what the lane sent. */
const scripted = () => {
  const listeners = new Map<string, Listener[]>();
  const sent: string[] = [];
  const socket: DrillSyncSocket = {
    send: (data) => void sent.push(data),
    close: () => undefined,
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  const fire = (type: string, data?: unknown): void => {
    for (const listener of listeners.get(type) ?? []) listener({ data });
  };
  return { socket, sent, fire };
};

describe('startDrillSync with its own sleep', () => {
  test('a dropped socket is re-dialled, and only the new hello reports it back', async () => {
    const sockets: ReturnType<typeof scripted>[] = [];
    const lane = startDrillSync({
      url: 'ws://sync.invalid/_x/sync',
      protocolVersion: 1,
      redialMs: 1,
      connect: () => {
        const one = scripted();
        sockets.push(one);
        return one.socket;
      },
    });
    const first = sockets[0];
    if (first === undefined) return expect.unreachable('the lane dials at once');
    first.fire('open');
    expect(JSON.parse(first.sent[0] ?? '{}')).toMatchObject({ type: 'hello', v: 1 });
    first.fire('message', 'not json at all');
    first.fire('message', JSON.stringify({ type: 'replay-gap' }));
    first.fire('close');
    while (sockets.length < 2) await new Promise((resolve) => setImmediate(resolve));
    const second = sockets[1];
    if (second === undefined) return expect.unreachable('the lane re-dialled');
    // Re-dialled but not yet greeted: the lane is not back, and the gap before the drop counted.
    expect(second.sent).toEqual([]);
    expect(await lane.stop()).toEqual({ reconnected: false, gaps: 1 });
  });

  test('the live socket answering hello is reconnected', async () => {
    const one = scripted();
    const lane = startDrillSync({
      url: 'ws://sync.invalid/_x/sync',
      protocolVersion: 2,
      subscriptions: [{ query: 'feed' }],
      connect: () => one.socket,
    });
    one.fire('message', JSON.stringify({ type: 'hello' }));
    expect(one.sent.map((frame) => JSON.parse(frame).type)).toEqual(['subscribe']);
    expect(await lane.stop()).toEqual({ reconnected: true, gaps: 0 });
  });
});
