// A declared channel end to end on one node: a change from the feed becomes a `records` frame with
// seq and epoch, a frame backpressure drops is repaired by `replay-gap`, a resume `since` replays
// from the ring or says to re-read — and a deliberately dropped frame still ends with the client's
// store equal to the server's rows.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { type Actor, isUltimateError, userActor } from '@ultimat3/core';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import type { QueryPolicy } from '@ultimat3/query';
import type { ChangeEvent } from './changefeed';
import { ChannelHub } from './channel';
import { channel } from './channel-decl';
import { clearChannels } from './channel-registry';
import type { ChannelRecordsFrame } from './channel-wire';
import { InProcessTransport } from './fanout';
// The wire's row — what a change event carries — so a test row is one the feed could deliver.
import type { Row } from './json';
import { OPEN_POLICY } from './policy-fake';
import { SocketRegistry, SyncSocket, type WsLike } from './socket';

const posts = entity('channel_seq_posts', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), ownerId: text(), title: text() },
});

afterAll(() => {
  clearRegistry();
  clearChannels();
});

/**
 * The org's members may join its feed; the membership fact is LOADED by the channel's `row`
 * loader, the rule stays synchronous. `raise` makes the loader fail rather than decide.
 */
let raise = false;
let subscribeChecks = 0;
const loaded: Array<Readonly<Record<string, string>>> = [];
const orgMembers: QueryPolicy = {
  kind: 'allow',
  label: 'org-member',
  permissions: [],
  children: [],
  run: ({ actor, row }) => {
    subscribeChecks += 1;
    const members = (row as { members?: readonly string[] } | null)?.members ?? [];
    return actor !== null && members.includes(actor.id)
      ? { allowed: true }
      : { allowed: false, reason: 'not a member', code: 'X_FORBIDDEN' };
  },
};

const feed = channel('org-feed', {
  params: ['orgId'],
  catchUp: { name: 'orgFeed' },
  policy: OPEN_POLICY,
  records: [posts],
});
const ownFeed = channel('own-feed', {
  params: ['orgId'],
  catchUp: { name: 'ownFeed' },
  records: [posts],
  policy: orgMembers,
  row: async ({ params }) => {
    loaded.push(params);
    if (raise) throw new TypeError('connection pool exhausted');
    return { members: ['alice', 'bob'] };
  },
});
const typing = channel('typing', {
  params: ['orgId'],
  catchUp: { name: 'none' },
  policy: OPEN_POLICY,
  events: true,
});

type Wire = { readonly type: string } & Record<string, unknown>;

class FakeWs implements WsLike {
  readonly frames: Wire[] = [];
  buffered = 0;
  send(data: string): number {
    this.frames.push(JSON.parse(data) as Wire);
    return data.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return this.buffered;
  }
  of(type: string): Wire[] {
    return this.frames.filter((frame) => frame.type === type);
  }
}

let transport: InProcessTransport;
let sockets: SocketRegistry;
let hub: ChannelHub;

beforeEach(() => {
  raise = false;
  subscribeChecks = 0;
  loaded.length = 0;
  transport = new InProcessTransport();
  sockets = new SocketRegistry();
  hub = new ChannelHub({ transport, sockets, channels: [feed, ownFeed, typing], ringSize: 4 });
});

function connect(who: string): { socket: SyncSocket; ws: FakeWs } {
  const ws = new FakeWs();
  const actor: Actor = userActor({ id: who });
  const socket = new SyncSocket({
    ws,
    clientBuildId: 'b',
    serverBuildId: 'b',
    actor,
    maxBufferedBytes: 10,
    maxDroppedFrames: 100,
  });
  sockets.add(socket);
  return { socket, ws };
}

const ORG = 'o1';
const post = (id: string, title: string, ownerId = 'alice'): Row => ({
  id,
  orgId: ORG,
  ownerId,
  title,
});
let lsn = 0;
const nextLsn = (): string => {
  lsn += 1;
  return String(lsn).padStart(16, '0');
};
const insert = (row: Row, op: ChangeEvent['op'] = 'insert'): ChangeEvent => ({
  entity: 'channel_seq_posts',
  op,
  before: op === 'insert' ? null : row,
  after: op === 'delete' ? null : row,
  lsn: nextLsn(),
  txid: '1',
  orgId: ORG,
  at: 0,
});

const records = (ws: FakeWs): ChannelRecordsFrame[] =>
  ws.of('records') as unknown as ChannelRecordsFrame[];

describe('records on a declared channel', () => {
  test('a change becomes one keyed records frame per member, seq counting up in one epoch', async () => {
    const a = connect('alice');
    const b = connect('bob');
    for (const s of [a, b])
      await hub.subscribeChannel(s.socket, {
        kind: 'channel',
        channel: 'org-feed',
        params: { orgId: ORG },
      });

    hub.deliverChange(insert(post('p1', 'one')));
    hub.deliverChange(insert(post('p1', 'two'), 'update'));

    for (const s of [a, b]) {
      const frames = records(s.ws);
      expect(frames.map((frame) => frame.seq)).toEqual([1, 2]);
      expect(new Set(frames.map((frame) => frame.epoch)).size).toBe(1);
      expect(frames[0]?.channel).toBe('org-feed.o1');
      expect(frames[1]?.adopt).toEqual({ channel_seq_posts: { p1: post('p1', 'two') } });
    }
  });

  test('a delete goes out as a remove by key, and every member gets the same frame', async () => {
    const a = connect('alice');
    const b = connect('bob');
    for (const s of [a, b]) {
      await hub.subscribeChannel(s.socket, {
        kind: 'channel',
        channel: 'org-feed',
        params: { orgId: ORG },
      });
    }
    hub.deliverChange(insert(post('p2', 'two'), 'delete'));
    expect(records(a.ws)).toEqual(records(b.ws));
    expect(records(a.ws)[0]?.remove).toEqual({ channel_seq_posts: ['p2'] });
    expect(records(a.ws)[0]?.adopt).toBeUndefined();
  });

  // No frame can enumerate what a TRUNCATE removed, so each member is told to re-read, at a NEW
  // epoch: nothing in the old ring may be replayed onto a table that no longer has those rows.
  test('a truncate is a replay-gap at a new epoch for every member, never a records frame', async () => {
    const a = connect('alice');
    await hub.subscribeChannel(a.socket, {
      kind: 'channel',
      channel: 'org-feed',
      params: { orgId: ORG },
    });
    hub.deliverChange(insert(post('p1', 'one')));
    const before = records(a.ws)[0]?.epoch;
    const gaps = a.ws.of('replay-gap').length;
    hub.deliverChange({ ...insert(post('p1', 'one')), op: 'truncate', before: null, after: null });
    const announced = a.ws.of('replay-gap');
    expect(announced).toHaveLength(gaps + 1);
    expect(announced.at(-1)?.['epoch']).not.toBe(before);
    expect(records(a.ws)).toHaveLength(1);
  });

  test('a member of another org’s topic receives nothing', async () => {
    const a = connect('alice');
    await hub.subscribeChannel(a.socket, {
      kind: 'channel',
      channel: 'org-feed',
      params: { orgId: 'o2' },
    });
    hub.deliverChange(insert(post('p1', 'one')));
    expect(records(a.ws)).toEqual([]);
  });

  test('a dropped records frame is counted, marked, and answered with replay-gap once drained', async () => {
    const a = connect('alice');
    await hub.subscribeChannel(a.socket, {
      kind: 'channel',
      channel: 'org-feed',
      params: { orgId: ORG },
    });
    a.ws.frames.length = 0; // the join's own replay-gap — its test is under 'resume since'

    a.ws.buffered = 100;
    hub.deliverChange(insert(post('p1', 'lost')));
    expect(sockets.droppedChannelFrames).toBe(1);
    expect(sockets.gapRepairs.pending(sockets.all())).toBe(1);
    expect(a.ws.of('replay-gap')).toEqual([]);

    a.ws.buffered = 0;
    expect(sockets.gapRepairs.repairAll(a.socket)).toBe(1);
    const [gap] = a.ws.of('replay-gap');
    expect(gap?.['channel']).toBe('org-feed.o1');
    // The gap names the epoch the lost frame was minted in — the one the stream continues in.
    hub.deliverChange(insert(post('p2', 'next')));
    expect(records(a.ws)[0]).toMatchObject({ seq: 2, epoch: gap?.['epoch'] });
    expect(sockets.gapRepairs.announced).toBe(1);
    expect(sockets.gapRepairs.pending(sockets.all())).toBe(0);
  });

  test('without a drain callback, the next delivery sends the owed replay-gap first', async () => {
    const a = connect('alice');
    await hub.subscribeChannel(a.socket, {
      kind: 'channel',
      channel: 'org-feed',
      params: { orgId: ORG },
    });
    a.ws.frames.length = 0; // the join's own replay-gap
    a.ws.buffered = 100;
    hub.deliverChange(insert(post('p1', 'lost')));
    a.ws.buffered = 0;
    hub.deliverChange(insert(post('p2', 'next')));
    expect(a.ws.frames.map((frame) => frame.type)).toEqual(['replay-gap', 'records']);
    expect(records(a.ws)[0]?.seq).toBe(2);
  });

  test('THE PROPERTY: a deliberately dropped frame ends with the store equal to the server rows', async () => {
    const server = new Map<string, Row>();
    // The client's copy holds whatever a frame adopted: core's row, not the wire's narrower one.
    const store = new Map<string, object>();
    const a = connect('alice');
    await hub.subscribeChannel(a.socket, {
      kind: 'channel',
      channel: 'org-feed',
      params: { orgId: ORG },
    });
    const write = (row: Row, op: ChangeEvent['op'] = 'insert'): void => {
      if (op === 'delete') server.delete(String(row['id']));
      else server.set(String(row['id']), row);
      hub.deliverChange(insert(row, op));
    };
    /** The client half, minimal: adopt/remove records, and re-read the catch-up on replay-gap. */
    const drainInto = (): void => {
      for (const frame of a.ws.frames.splice(0)) {
        if (frame.type === 'replay-gap') {
          store.clear();
          for (const [id, row] of server) store.set(id, row);
          continue;
        }
        const recordsFrame = frame as unknown as ChannelRecordsFrame;
        for (const [id, row] of Object.entries(recordsFrame.adopt?.['channel_seq_posts'] ?? {})) {
          store.set(id, row);
        }
        for (const id of recordsFrame.remove?.['channel_seq_posts'] ?? []) store.delete(id);
      }
    };

    write(post('p1', 'one'));
    drainInto();
    a.ws.buffered = 100;
    write(post('p1', 'edited-while-drowning'), 'update');
    write(post('p2', 'two'));
    a.ws.buffered = 0;
    sockets.gapRepairs.repairAll(a.socket);
    drainInto();

    expect(store).toEqual(server);
  });
});

describe('resume since', () => {
  // The client's own read (the island's seed) and this seat are on two connections, so a commit
  // between the read and the seat reached nobody: measured in the reference app, a like made while
  // the page's socket was joining never reached the tab that made it. The seat is the one point
  // after which every commit is a frame — so the re-read has to start from HERE.
  test('a fresh join is answered replay-gap once; a repeated add on the socket is not', async () => {
    const a = connect('alice');
    const target = { kind: 'channel', channel: 'org-feed', params: { orgId: ORG } } as const;
    await hub.subscribeChannel(a.socket, target);
    const [gap] = a.ws.of('replay-gap');
    expect(gap).toMatchObject({ channel: 'org-feed.o1' });

    await hub.subscribeChannel(a.socket, target); // the presence beat: same membership again
    expect(a.ws.of('replay-gap')).toHaveLength(1);
    hub.deliverChange(insert(post('p1', 'one')));
    expect(records(a.ws)[0]).toMatchObject({ seq: 1, epoch: gap?.['epoch'] });
  });

  test('a resubscribe inside the ring replays exactly what was missed', async () => {
    const a = connect('alice');
    const target = { kind: 'channel', channel: 'org-feed', params: { orgId: ORG } } as const;
    await hub.subscribeChannel(a.socket, target);
    hub.deliverChange(insert(post('p1', 'one')));
    const [first] = records(a.ws);
    hub.deliverChange(insert(post('p2', 'two')));
    hub.deliverChange(insert(post('p3', 'three')));

    const b = connect('alice');
    await hub.subscribeChannel(b.socket, {
      ...target,
      since: { epoch: first?.epoch ?? '', seq: 1 },
    });
    expect(records(b.ws).map((frame) => frame.seq)).toEqual([2, 3]);
    expect(b.ws.of('replay-gap')).toEqual([]);
  });

  test('a change a keyed write made names that write — live, and again when the ring replays it', async () => {
    const a = connect('alice');
    const target = { kind: 'channel', channel: 'org-feed', params: { orgId: ORG } } as const;
    await hub.subscribeChannel(a.socket, target);
    const write = 'd'.repeat(32);
    hub.deliverChange({ ...insert(post('p1', 'one')), write });
    hub.deliverChange(insert(post('p2', 'two')));
    const live = records(a.ws);
    expect(live.map((frame) => frame.write)).toEqual([write, undefined]);
    expect(Object.hasOwn(live[1] ?? {}, 'write')).toBe(false);

    const b = connect('alice');
    await hub.subscribeChannel(b.socket, {
      ...target,
      since: { epoch: live[0]?.epoch ?? '', seq: 0 },
    });
    expect(records(b.ws).map((frame) => frame.write)).toEqual([write, undefined]);
  });

  test('a position outside the ring, or from another epoch, is answered replay-gap', async () => {
    const a = connect('alice');
    const target = { kind: 'channel', channel: 'org-feed', params: { orgId: ORG } } as const;
    await hub.subscribeChannel(a.socket, target);
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) hub.deliverChange(insert(post(id, id)));
    const epoch = records(a.ws)[0]?.epoch ?? '';

    const b = connect('alice');
    await hub.subscribeChannel(b.socket, { ...target, since: { epoch, seq: 1 } });
    expect(b.ws.of('replay-gap')).toEqual([
      expect.objectContaining({ channel: 'org-feed.o1', epoch }),
    ]);

    const c = connect('alice');
    await hub.subscribeChannel(c.socket, { ...target, since: { epoch: 'another-node:1', seq: 6 } });
    expect(c.ws.of('replay-gap')).toHaveLength(1);
    expect(records(c.ws)).toEqual([]);
  });

  test('a topic reopened after its last member left starts a NEW epoch', async () => {
    const a = connect('alice');
    await hub.subscribeChannel(a.socket, {
      kind: 'channel',
      channel: 'org-feed',
      params: { orgId: ORG },
    });
    hub.deliverChange(insert(post('p1', 'one')));
    const before = records(a.ws)[0]?.epoch;
    hub.unsubscribe(a.socket, feed.topic({ orgId: ORG }));

    const b = connect('alice');
    await hub.subscribeChannel(b.socket, {
      kind: 'channel',
      channel: 'org-feed',
      params: { orgId: ORG },
    });
    hub.deliverChange(insert(post('p2', 'two')));
    const [after] = records(b.ws);
    expect(after?.seq).toBe(1);
    expect(after?.epoch).not.toBe(before);
  });
});

describe('authorization', () => {
  const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
    try {
      await run();
    } catch (error) {
      return isUltimateError(error) ? error.code : 'not an UltimateError';
    }
    return 'did not throw';
  };

  test('a policy denial is X_TOPIC_FORBIDDEN, latched, and leaves the socket’s other channels flowing', async () => {
    const m = connect('mallory');
    const own = { kind: 'channel', channel: 'own-feed', params: { orgId: ORG } } as const;
    expect(await codeOf(() => hub.subscribeChannel(m.socket, own))).toBe('X_TOPIC_FORBIDDEN');
    expect(await codeOf(() => hub.subscribeChannel(m.socket, own))).toBe('X_TOPIC_FORBIDDEN');
    expect(subscribeChecks).toBe(1);

    await hub.subscribeChannel(m.socket, {
      kind: 'channel',
      channel: 'org-feed',
      params: { orgId: ORG },
    });
    hub.deliverChange(insert(post('p1', 'one')));
    expect(records(m.ws).map((frame) => frame.channel)).toEqual(['org-feed.o1']);
  });

  test('the policy decides on the row the channel loaded, from the params', async () => {
    const a = connect('alice');
    await hub.subscribeChannel(a.socket, {
      kind: 'channel',
      channel: 'own-feed',
      params: { orgId: ORG },
    });
    expect(loaded).toEqual([{ orgId: ORG }]);
  });

  test('a loader that RAISED is not a denial: nothing is latched, and the next try re-decides', async () => {
    const a = connect('alice');
    const own = { kind: 'channel', channel: 'own-feed', params: { orgId: ORG } } as const;
    raise = true;
    expect(await codeOf(() => hub.subscribeChannel(a.socket, own))).toBe('not an UltimateError');
    raise = false;
    expect(String(await hub.subscribeChannel(a.socket, own))).toBe('own-feed.o1');
  });

  test('a new session re-decides a latched denial', async () => {
    const m = connect('mallory');
    const own = { kind: 'channel', channel: 'own-feed', params: { orgId: ORG } } as const;
    await codeOf(() => hub.subscribeChannel(m.socket, own));
    await hub.onActorChange(m.socket, userActor({ id: 'alice' }));
    expect(String(await hub.subscribeChannel(m.socket, own))).toBe('own-feed.o1');
  });

  test('an undeclared channel name and a missing param are refused', async () => {
    const a = connect('alice');
    expect(
      await codeOf(() =>
        hub.subscribeChannel(a.socket, { kind: 'channel', channel: 'nope', params: {} }),
      ),
    ).toBe('X_TOPIC_FORBIDDEN');
    expect(
      await codeOf(() =>
        hub.subscribeChannel(a.socket, { kind: 'channel', channel: 'org-feed', params: {} }),
      ),
    ).toBe('X_TOPIC_FORBIDDEN');
  });

  test('a second channel() of a registered name is refused', () => {
    expect(() =>
      channel('org-feed', { params: [], catchUp: { name: 'x' }, policy: OPEN_POLICY }),
    ).toThrow(expect.objectContaining({ code: 'X_CHANNEL_DECLARATION_INVALID' }));
  });
});

describe('events', () => {
  test('an event reaches every member through the bus and carries no seq', async () => {
    const a = connect('alice');
    await hub.subscribeChannel(a.socket, {
      kind: 'channel',
      channel: 'typing',
      params: { orgId: ORG },
    });
    await hub.publishEvent(typing, { orgId: ORG }, { who: 'bob' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(a.ws.of('events')).toEqual([
      { type: 'events', v: expect.any(Number), channel: 'typing.o1', event: { who: 'bob' } },
    ]);
    expect(records(a.ws)).toEqual([]);
  });

  test('a channel that declares no events refuses one', async () => {
    await expect(hub.publishEvent(feed, { orgId: ORG }, { x: 1 })).rejects.toMatchObject({
      code: 'X_CHANNEL_DECLARATION_INVALID',
    });
  });
});
