// The change bus as a channel member sees it: a hole in a producer's sequence (#681) and a bus that
// reconnected both reach every records topic as `replay-gap` at a NEW epoch, and a change a
// `recordPublisher` sent (#682) feeds the channels and never a live window it cannot order.

import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { logger, userActor } from '@ultimat3/core';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import { RingChangeBuffer } from './change-buffer';
import type { ChangeEvent } from './changefeed';
import { ChannelHub } from './channel';
import { channel } from './channel-decl';
import { clearChannels } from './channel-registry';
import { InProcessTransport } from './fanout';
import { LiveQueryRegistry } from './live-query';
import { OPEN_POLICY } from './policy-fake-fixture';
import { SeqGapDetector } from './replicator-envelope';
import { SocketRegistry, SyncSocket, type WsLike } from './socket';
import { changeHandler, ProducerKinds, reconnectHandler, type SyncBus } from './sync-bus-handlers';

const posts = entity('bus_gap_posts', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), title: text() },
});
const feed = channel('bus-gap-feed', {
  params: ['orgId'],
  catchUp: { name: 'busGapFeed' },
  policy: OPEN_POLICY,
  records: [posts],
});

afterAll(() => {
  clearRegistry();
  clearChannels();
});

type Wire = { readonly type: string } & Record<string, unknown>;

class FakeWs implements WsLike {
  readonly frames: Wire[] = [];
  send(data: string): number {
    this.frames.push(JSON.parse(data) as Wire);
    return data.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
  of(type: string): Wire[] {
    return this.frames.filter((frame) => frame.type === type);
  }
}

/** A registry that only records, so what reached the live windows is the assertion. */
class RecordingRegistry extends LiveQueryRegistry {
  readonly delivered: ChangeEvent[] = [];
  invalidated = 0;
  override async deliver(event: ChangeEvent): Promise<number> {
    this.delivered.push(event);
    return 0;
  }
  override invalidate(): number {
    this.invalidated += 1;
    return 0;
  }
}

const ORG = '00000000-0000-4000-8000-000000000001';
let registry: RecordingRegistry;
let bus: SyncBus;
let ws: FakeWs;

beforeEach(async () => {
  const sockets = new SocketRegistry();
  const hub = new ChannelHub({ transport: new InProcessTransport(), sockets, channels: [feed] });
  registry = new RecordingRegistry({ source: new RingChangeBuffer() });
  bus = { registry, hub, gaps: new SeqGapDetector(), producers: new ProducerKinds() };
  ws = new FakeWs();
  const socket = new SyncSocket({
    ws,
    clientBuildId: 'b',
    serverBuildId: 'b',
    actor: userActor({ id: 'alice', orgId: ORG }),
  });
  sockets.add(socket);
  await hub.subscribeChannel(socket, {
    kind: 'channel',
    channel: feed.name,
    params: { orgId: ORG },
  });
  // The fresh seat's own replay-gap is the join's answer, not this file's subject.
  ws.frames.length = 0;
});

let position = 0;
const envelope = (id: string, seq: number, producer: string, source?: 'publisher'): string => {
  position += 1;
  return JSON.stringify({
    table: 'bus_gap_posts',
    op: 'insert',
    before: null,
    after: { id, orgId: ORG, title: id },
    lsn: String(position).padStart(16, '0'),
    txid: String(position),
    orgId: ORG,
    at: 0,
    write: null,
    seq,
    producer,
    ...(source === undefined ? {} : { source }),
  });
};

describe('a hole in the change stream (#681)', () => {
  test('tells every records member replay-gap at a new epoch, then delivers in it', () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
    const handle = changeHandler(bus);
    handle(envelope('p1', 1, 'replicator-run'));
    const [first] = ws.of('records');
    expect(ws.of('replay-gap')).toEqual([]);

    // seq 2 never arrived: the bus is at most once.
    handle(envelope('p3', 3, 'replicator-run'));

    const gaps = ws.of('replay-gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.['channel']).toBe(feed.topic({ orgId: ORG }));
    expect(gaps[0]?.['epoch']).not.toBe(first?.['epoch']);
    // The frame that exposed the hole still lands — in the new epoch, behind the client's re-read.
    expect(ws.of('records').at(-1)).toMatchObject({ seq: 1, epoch: gaps[0]?.['epoch'] });
    expect(registry.invalidated).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      'live.change_gap',
      expect.objectContaining({ channelGaps: 1 }),
    );
    warn.mockRestore();
  });

  test('a bus that reconnected is a replay-gap too, with no later message to notice it by', () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
    reconnectHandler(bus)();
    expect(ws.of('replay-gap')).toHaveLength(1);
    expect(registry.invalidated).toBe(1);
    warn.mockRestore();
  });
});

describe('a change a record publisher sent (#682)', () => {
  test('reaches the channels and never a live window: it carries no commit position', () => {
    changeHandler(bus)(envelope('p1', 1, 'worker-a', 'publisher'));
    expect(ws.of('records')).toHaveLength(1);
    expect(registry.delivered).toEqual([]);
  });

  test('a second publisher is not a gap: publishers run side by side, a replicator run never does', () => {
    const handle = changeHandler(bus);
    handle(envelope('p1', 1, 'worker-a', 'publisher'));
    handle(envelope('p2', 1, 'worker-b', 'publisher'));
    handle(envelope('p3', 2, 'worker-a', 'publisher'));
    expect(ws.of('replay-gap')).toEqual([]);
    expect(ws.of('records').map((frame) => frame['seq'])).toEqual([1, 2, 3]);
  });

  test('a hole in one publisher’s sequence is repaired like any other', () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
    const handle = changeHandler(bus);
    handle(envelope('p1', 1, 'worker-a', 'publisher'));
    handle(envelope('p3', 3, 'worker-a', 'publisher'));
    expect(ws.of('replay-gap')).toHaveLength(1);
    // The lost change was never a window's, so no live subscriber is re-snapshotted for it.
    expect(registry.invalidated).toBe(0);
    warn.mockRestore();
  });
});

// One producer KIND per table (#682 follow-up): a replicator and a publisher carrying the same
// table is every committed row twice on every channel. The node keeps the kind it saw first and
// drops the other's envelopes, said once per table under a code — in either order.
describe('two kinds of producer on one table', () => {
  const conflicts = (warn: { mock: { calls: readonly unknown[][] } }): unknown[] =>
    warn.mock.calls.filter((call) => call[0] === 'X_REALTIME_PRODUCER_CONFLICT');

  test('a publisher after the replicator is dropped, and said once', () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
    const handle = changeHandler(bus);
    handle(envelope('p1', 1, 'replicator-run'));
    handle(envelope('p2', 1, 'worker-a', 'publisher'));
    handle(envelope('p3', 2, 'worker-a', 'publisher'));
    handle(envelope('p4', 2, 'replicator-run'));
    expect(ws.of('records').map((frame) => frame['adopt'])).toEqual([
      { bus_gap_posts: { p1: expect.anything() } },
      { bus_gap_posts: { p4: expect.anything() } },
    ]);
    expect(conflicts(warn)).toHaveLength(1);
    expect(conflicts(warn)[0]).toEqual([
      'X_REALTIME_PRODUCER_CONFLICT',
      expect.objectContaining({ table: 'bus_gap_posts', kept: 'replicator', dropped: 'publisher' }),
    ]);
    // The dropped envelopes were never a hole in anything, and never reached a window.
    expect(ws.of('replay-gap')).toEqual([]);
    expect(registry.delivered.map((change) => change.after?.['id'])).toEqual(['p1', 'p4']);
    warn.mockRestore();
  });

  test('the replicator after a publisher is dropped, and said once', () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
    const handle = changeHandler(bus);
    handle(envelope('p1', 1, 'worker-a', 'publisher'));
    handle(envelope('p2', 1, 'replicator-run'));
    handle(envelope('p3', 2, 'replicator-run'));
    handle(envelope('p4', 2, 'worker-a', 'publisher'));
    expect(ws.of('records')).toHaveLength(2);
    expect(registry.delivered).toEqual([]);
    expect(conflicts(warn)).toHaveLength(1);
    expect(conflicts(warn)[0]).toEqual([
      'X_REALTIME_PRODUCER_CONFLICT',
      expect.objectContaining({ table: 'bus_gap_posts', kept: 'publisher', dropped: 'replicator' }),
    ]);
    warn.mockRestore();
  });
});
