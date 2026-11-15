// A node that missed changes re-serves its live windows NOW, not on the query's next change: a
// quiet query that moved during a bus outage has no later change to notice it by, and the page
// went on showing the rows from before the outage until the node's idle sweep (up to 30 s) or a
// write. Found by `multi-node.live.test.ts` over a real bus; held here on the in-process one.

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { logger } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { formatLsn } from './changefeed';
import { ChannelHub } from './channel';
import { InProcessTransport } from './fanout';
import type { LiveRow } from './json';
import type { LiveQueryDefinition } from './live-contract';
import { LiveQueryRegistry } from './live-query';
import { patchFromChange } from './matcher-bridge';
import { encodeResync } from './replication-resync';
import { encodeEnvelope, SeqGapDetector } from './replicator-envelope';
import { turns } from './replicator-rig-fixture';
import { SocketRegistry, SyncSocket, type WsLike } from './socket';
import { changeHandler, ProducerKinds, reconnectHandler, type SyncBus } from './sync-bus-handlers';
import { decode, type Frame } from './sync-protocol';

class FakeWs implements WsLike {
  readonly frames: Frame[] = [];
  send(data: string): number {
    this.frames.push(decode(data));
    return data.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
  snapshots(): LiveRow[][] {
    return this.frames.flatMap((frame) => (frame.type === 'snapshot' ? [[...frame.rows]] : []));
  }
}

/** The database the window reads: changed behind the node's back while its bus was down. */
let rows: LiveRow[] = [];
let position = 1;

const quiet: LiveQueryDefinition = {
  name: 'quietFeed',
  entities: ['quiet_posts'],
  snapshot: async () => ({ rows, lsn: formatLsn(position) }),
  visible: () => true,
  matcher: () => ({
    entities: ['quiet_posts'],
    match: (change) => {
      const patch = patchFromChange(change);
      return { patches: patch ? [patch] : [], refill: false };
    },
  }),
};

let bus: SyncBus;
let ws: FakeWs;
let warn: ReturnType<typeof spyOn>;

beforeEach(async () => {
  warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
  rows = [{ id: 'p1', title: 'before' }];
  position = 1;
  const sockets = new SocketRegistry();
  const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(quiet);
  const hub = new ChannelHub({ transport: new InProcessTransport(), sockets });
  bus = { registry, hub, gaps: new SeqGapDetector(), producers: new ProducerKinds() };
  ws = new FakeWs();
  const socket = new SyncSocket({ ws, clientBuildId: 'b', serverBuildId: 'b', actor: null });
  sockets.add(socket);
  const { frame } = await registry.subscribe({ socket, name: 'quietFeed', input: {}, sid: 's1' });
  socket.send(frame);
});

afterEach(() => {
  warn.mockRestore();
});

/** What the outage hid: a write this node never heard of. */
const writeBehindTheNode = (): void => {
  rows = [{ id: 'p1', title: 'after' }];
  position = 2;
};

describe('a node that missed changes repairs its quiet windows at once', () => {
  test('a bus reconnect re-serves every live window with no later change', async () => {
    writeBehindTheNode();
    reconnectHandler(bus)();
    await turns();
    expect(ws.snapshots().map((each) => each.map((row) => row['title']))).toEqual([
      ['before'],
      ['after'],
    ]);
  });

  test('a resync the replicator said re-serves every live window with no later change', async () => {
    writeBehindTheNode();
    changeHandler(bus)(encodeResync({ producer: 'r1', reason: 'slot recreated' }));
    await turns();
    // Re-read, not the cached pre-outage window re-sent.
    expect(ws.snapshots().map((each) => each.map((row) => row['title']))).toEqual([
      ['before'],
      ['after'],
    ]);
  });

  // Already true before the fix, held so it stays true: the message that shows the hole is
  // delivered to every stale window, whatever table it is on.
  test("a hole seen on another table's change re-serves this window too", async () => {
    const other = (seq: number, lsn: number): string =>
      encodeEnvelope(
        {
          table: 'other_posts',
          op: 'insert',
          before: null,
          after: { id: `o${seq}` },
          lsn: formatLsn(lsn),
          txid: String(lsn),
          orgId: null,
          at: 0,
          write: null,
        },
        seq,
        'run-1',
      );
    const handle = changeHandler(bus);
    handle(other(1, 1));
    writeBehindTheNode();
    // seq 2 — the quiet table's write — never arrived.
    handle(other(3, 3));
    await turns();
    expect(ws.snapshots().map((each) => each.map((row) => row['title']))).toEqual([
      ['before'],
      ['after'],
    ]);
  });
});
