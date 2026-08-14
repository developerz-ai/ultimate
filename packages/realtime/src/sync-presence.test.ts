// Presence is only real if the node speaks it. `PresenceRegistry` had no caller anywhere for as
// long as it existed, so what is proven here is the wiring: a topic subscribe joins, a drop and a
// closed socket leave, and the members a joiner is told about are the ones on the shared set —
// which is the KV bucket under NATS and the in-process map under `x dev`.

import { describe, expect, spyOn, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { ChannelHub, type Topic, topic } from './channel';
import { InProcessTransport } from './fanout';
import { LiveQueryRegistry } from './live-query';
import { PresenceRegistry } from './presence';
import { SocketRegistry } from './socket';
import { createSyncNode, type SyncNode, type SyncWs, type WsData } from './sync-node';
import { decode, encode, type Frame, PROTOCOL_VERSION } from './sync-protocol';

const BUILD_ID = 'build-1';
const ROOM: Topic = topic('org', 'o1', 'cursors');

/** A socket that records what the node sent it, with no server and no network in the way. */
class RecordingWs implements SyncWs {
  readonly sent: Frame[] = [];
  readonly data: WsData;
  readyState = 1;

  constructor(id: string) {
    this.data = { socketId: id, clientBuildId: BUILD_ID, actorId: null };
  }

  send(message: string): number {
    this.sent.push(decode(message));
    return message.length;
  }

  close(): void {
    this.readyState = 3;
  }

  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }

  frames(op: string): Frame[] {
    return this.sent.filter((frame) => frame.type === 'presence' && frame.op === op);
  }
}

interface Harness {
  readonly node: SyncNode;
  readonly presence: PresenceRegistry;
  readonly tick: (ms: number) => void;
  connect(id: string): RecordingWs;
  send(ws: RecordingWs, frame: Frame): Promise<void>;
  join(ws: RecordingWs): Promise<void>;
}

function harness(ttlMs = 30_000): Harness {
  const clock = frozenClock(0);
  const sockets = new SocketRegistry({ clock });
  const transport = new InProcessTransport({ clock });
  const hub = new ChannelHub({ transport, sockets });
  // Deny by default is the hub's rule; this room is the one thing these tests are allowed into.
  hub.guard('org.>', () => true);
  const presence = new PresenceRegistry({ transport, hub, clock, ttlMs });
  const node = createSyncNode({
    hub,
    registry: new LiveQueryRegistry({ source: new RingChangeBuffer() }),
    transport,
    buildId: BUILD_ID,
    sockets,
    presence,
    clock,
  });
  const send = async (ws: RecordingWs, frame: Frame): Promise<void> => {
    node.websocket.message(ws, encode(frame));
    // `message` dispatches an async route and returns; one turn is enough for an in-process bus.
    await Bun.sleep(1);
  };
  return {
    node,
    presence,
    tick: (ms) => clock.advance(ms),
    connect(id: string): RecordingWs {
      const ws = new RecordingWs(id);
      node.websocket.open(ws);
      return ws;
    },
    send,
    join: (ws) =>
      send(ws, {
        type: 'subscribe',
        v: PROTOCOL_VERSION,
        op: 'add',
        sid: ws.data.socketId,
        target: { kind: 'topic', topic: ROOM },
      }),
  };
}

describe('the sync node speaks presence', () => {
  test('subscribing to a topic joins it, and the joiner is told who is already there', async () => {
    const app = harness();
    const first = app.connect('s1');
    await app.join(first);
    const second = app.connect('s2');
    await app.join(second);

    // The second joiner's own sync frame is the whole set, not a delta — presence has no delta.
    const sync = second.frames('sync').at(-1);
    expect(sync?.type === 'presence' ? sync.members.map((m) => m.id).sort() : []).toEqual([
      's1',
      's2',
    ]);
    // ...and the member is on the shared set, which is the only thing another node can read.
    expect((await app.presence.list(ROOM)).map((member) => member.id)).toEqual(['s1', 's2']);
  });

  test('a join is announced to everyone already in the room', async () => {
    const app = harness();
    const first = app.connect('s1');
    await app.join(first);
    await app.join(app.connect('s2'));

    const joins = first.frames('join');
    const last = joins.at(-1);
    expect(last?.type === 'presence' ? last.members.map((m) => m.id) : []).toEqual(['s2']);
  });

  test('dropping the subscription leaves: the room does not wait out the TTL', async () => {
    const app = harness();
    const watcher = app.connect('s1');
    await app.join(watcher);
    const leaver = app.connect('s2');
    await app.join(leaver);

    await app.send(leaver, {
      type: 'subscribe',
      v: PROTOCOL_VERSION,
      op: 'drop',
      sid: 's2',
      target: { kind: 'topic', topic: ROOM },
    });

    expect((await app.presence.list(ROOM)).map((member) => member.id)).toEqual(['s1']);
    const leaves = watcher.frames('leave');
    expect(leaves.at(-1)?.type === 'presence' ? leaves.length : 0).toBe(1);
  });

  test('a closed socket leaves every topic it held', async () => {
    const app = harness();
    const watcher = app.connect('s1');
    await app.join(watcher);
    const gone = app.connect('s2');
    await app.join(gone);

    app.node.websocket.close(gone);
    await Bun.sleep(1);

    expect((await app.presence.list(ROOM)).map((member) => member.id)).toEqual(['s1']);
    expect(watcher.frames('leave')).toHaveLength(1);
  });

  test('re-sending the subscribe is the heartbeat: no second frame kind, no expiry', async () => {
    const app = harness();
    const ws = app.connect('s1');
    await app.join(ws);

    app.tick(20_000);
    await app.join(ws);
    app.tick(20_000);

    expect((await app.presence.list(ROOM)).map((member) => member.id)).toEqual(['s1']);
  });

  test('a sweep turns silent expiry into the leave frame nobody else would send', async () => {
    const app = harness();
    const watcher = app.connect('s1');
    await app.join(watcher);
    const silent = app.connect('s2');
    await app.join(silent);

    // s1 keeps beating; s2's node died, so it stops and expires on the shared set's own clock.
    app.tick(20_000);
    expect(await app.presence.heartbeat(ROOM, 's1')).toBe(true);
    app.tick(11_000);
    // The sweep therefore has to distinguish the two rather than clear the whole room.
    const gone = await app.presence.sweepAll();

    expect(gone.map((member) => member.id)).toEqual(['s2']);
    expect(watcher.frames('leave')).toHaveLength(1);
    // Nobody leaves twice: a second pass over the same expiry would be a leave frame per sweep
    // for the rest of the process. An emptied room is also forgotten, so re-entering it works.
    await app.presence.leave(ROOM, 's1');
    expect(await app.presence.sweepAll()).toHaveLength(0);
    await app.join(watcher);
    expect((await app.presence.list(ROOM)).map((member) => member.id)).toEqual(['s1']);
    expect(await app.presence.sweepAll()).toHaveLength(0);
  });
});

describe('the node runs the sweep', () => {
  // Real wall-clock, deliberately: the interval is the thing under test, and a frozen clock would
  // prove the sweep works while leaving "nothing ever calls it" exactly as true as it was.
  test('start() schedules it and stop() clears it', async () => {
    const app = harness(3_000);
    const swept = spyOn(app.presence, 'sweepAll');
    await app.node.start();
    await Bun.sleep(1_200);

    expect(swept.mock.calls.length).toBeGreaterThan(0);
    await app.node.stop();
    const after = swept.mock.calls.length;
    await Bun.sleep(1_200);

    // A timer left behind sweeps for a node that has stopped, on a transport that may be closed.
    expect(swept.mock.calls.length).toBe(after);
  }, 10_000);

  test('drain() clears it too, without waiting for a stop() that may never come', async () => {
    const app = harness(3_000);
    const swept = spyOn(app.presence, 'sweepAll');
    await app.node.start();
    await Bun.sleep(1_200);
    expect(swept.mock.calls.length).toBeGreaterThan(0);

    await app.node.drain({ graceMs: 0 });
    const after = swept.mock.calls.length;
    await Bun.sleep(1_200);

    // A drained node has handed its sockets to the fleet: it is sweeping a room it has left,
    // and it does it through a hub `drain()` already closed.
    expect(swept.mock.calls.length).toBe(after);
    await app.node.stop();
  }, 10_000);
});
