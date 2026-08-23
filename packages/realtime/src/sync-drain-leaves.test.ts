// What `drain()` owes the REST of the fleet. A presence leave is a write to the shared set, and
// the node's `teardown` can only fire it — Bun's close callback is synchronous, so nothing there
// can await one. A drain has no callback behind it and IS the whole release, so it is the one path
// that can wait: released, the hub closed and the process gone with N·M writes still in flight,
// every other node renders the drained members for a full TTL.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { ChannelHub, type Topic, topic } from './channel';
import { InProcessTransport, type Transport } from './fanout';
import { LiveQueryRegistry } from './live-query';
import { PresenceRegistry } from './presence';
import { SocketRegistry } from './socket';
import { createSyncNode, type SyncWs, type WsData } from './sync-node';
import { encode, PROTOCOL_VERSION } from './sync-protocol';

const BUILD_ID = 'build-1';
const ROOM: Topic = topic('org', 'o1', 'cursors');

class SilentWs implements SyncWs {
  readonly data: WsData;

  constructor(id: string) {
    this.data = { socketId: id, clientBuildId: BUILD_ID };
  }

  send(message: string): number {
    return message.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}

/** A bus whose `drop` — the presence leave — is parked until the test lets it through. */
function gatedTransport(base: Transport): {
  readonly transport: Transport;
  readonly settled: () => number;
  open(): void;
} {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let settled = 0;
  return {
    settled: () => settled,
    open: () => release(),
    transport: {
      name: base.name,
      publish: (subject, payload) => base.publish(subject, payload),
      subscribe: (subject, handler) => base.subscribe(subject, handler),
      close: () => base.close(),
      shared: {
        put: (key, member, value, ttlMs) => base.shared.put(key, member, value, ttlMs),
        touch: (key, member, ttlMs) => base.shared.touch(key, member, ttlMs),
        entries: (key) => base.shared.entries(key),
        async drop(key: string, member: string): Promise<void> {
          await gate;
          await base.shared.drop(key, member);
          settled += 1;
        },
      },
    },
  };
}

describe('drain() waits out the presence leaves it started', () => {
  test('the drain does not resolve until every leave has landed on the shared set', async () => {
    const clock = frozenClock(0);
    const sockets = new SocketRegistry({ clock });
    const bus = new InProcessTransport({ clock });
    const gated = gatedTransport(bus);
    const hub = new ChannelHub({ transport: bus, sockets });
    hub.guard('org.>', () => true);
    const presence = new PresenceRegistry({
      transport: gated.transport,
      hub,
      clock,
      ttlMs: 30_000,
    });
    const node = createSyncNode({
      hub,
      registry: new LiveQueryRegistry({ source: new RingChangeBuffer() }),
      transport: bus,
      buildId: BUILD_ID,
      sockets,
      presence,
      clock,
    });

    for (const id of ['s1', 's2', 's3']) {
      const ws = new SilentWs(id);
      node.websocket.open(ws);
      node.websocket.message(
        ws,
        encode({
          type: 'subscribe',
          v: PROTOCOL_VERSION,
          op: 'add',
          sid: id,
          target: { kind: 'topic', topic: ROOM },
        }),
      );
    }
    await Bun.sleep(2);
    expect((await presence.list(ROOM)).length).toBe(3);

    let drained = false;
    const draining = node.drain({ graceMs: 0 }).then(() => {
      drained = true;
    });
    await Bun.sleep(2);

    // The whole finding: `release()` and `hub.close()` ran under three in-flight KV writes and the
    // drain reported itself finished — so a process that exits here leaves every other node
    // rendering three members who are provably gone, for the full 30s TTL, beside the same clients
    // already reconnected elsewhere under new socket ids.
    expect(drained).toBe(false);
    expect(gated.settled()).toBe(0);

    gated.open();
    await draining;

    expect(gated.settled()).toBe(3);
    expect((await presence.list(ROOM)).length).toBe(0);
  });
});
