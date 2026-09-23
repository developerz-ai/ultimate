// The socket engine under the in-page host — real `MessageChannel`s, a fake server socket — which
// is the same engine and the same protocol the SharedWorker runs, so this tests the worker's
// logic. Two tabs, one socket: wants are reference-counted, frames routed, a closed tab reaped.

import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { LiveClient } from './client';
import { FakeSocket } from './hooks-fixture';
import { RecordStore } from './record-store';
import { REAP_AFTER_BEATS, SocketEngine } from './socket-engine';
import { openHost, type SocketHost } from './socket-host';
import { PROTOCOL_VERSION, type SubscribeFrame } from './sync-protocol';
import type { Scheduler } from './thundering-herd';

const target = { url: 'ws://node.test/_x/sync', buildId: 'b1' };
const orgFeed = {
  name: 'org-feed',
  catchUp: 'orgFeed',
  topic: (params: Readonly<Record<'orgId', string>>) => `org-feed.${params.orgId}`,
};

/** Every armed timer, fired by hand: the engine arms a beat, a reaper and a reconnect at once. */
function timers(): { schedule: Scheduler; fire: () => void } {
  let armed: { fn: () => void; live: boolean }[] = [];
  return {
    schedule: (fn) => {
      const entry = { fn, live: true };
      armed.push(entry);
      return () => {
        entry.live = false;
      };
    },
    fire: () => {
      const due = armed.filter((entry) => entry.live);
      armed = [];
      for (const entry of due) entry.fn();
    },
  };
}

/** MessageChannel delivers a task later; a few turns lets a round trip land. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

interface Rig {
  readonly engine: SocketEngine;
  readonly servers: FakeSocket[];
  readonly clock: ReturnType<typeof frozenClock>;
  readonly engineTimers: ReturnType<typeof timers>;
  tab(catchUp?: (query: string) => Promise<unknown>): {
    client: LiveClient;
    store: RecordStore;
    host: SocketHost;
  };
}

const open: SocketHost[] = [];

function rig(): Rig {
  const servers: FakeSocket[] = [];
  const clock = frozenClock(1_000);
  const engineTimers = timers();
  const engine = new SocketEngine({
    dial: () => {
      const socket = new FakeSocket();
      servers.push(socket);
      return socket;
    },
    scheduler: engineTimers.schedule,
    clock,
    heartbeatMs: 1_000,
    rng: () => 0,
  });
  return {
    engine,
    servers,
    clock,
    engineTimers,
    tab: (catchUp = async () => undefined) => {
      const host = openHost({ scope: 'alice', inPageEngine: () => engine });
      open.push(host);
      const store = new RecordStore();
      const client = new LiveClient({
        connect: () => host.socket(target),
        buildId: 'b1',
        store,
        heartbeatMs: 0,
        scheduler: () => () => {},
        catchUp,
      });
      client.connect();
      return { client, store, host };
    },
  };
}

afterEach(() => {
  for (const host of open.splice(0)) host.bye();
});

function channelFrames(server: FakeSocket | undefined): SubscribeFrame[] {
  return (server?.frames() ?? []).filter(
    (frame): frame is SubscribeFrame =>
      frame.type === 'subscribe' && frame.target.kind === 'channel',
  );
}

async function upAndRunning(): Promise<
  Rig & { a: ReturnType<Rig['tab']>; b: ReturnType<Rig['tab']> }
> {
  const r = rig();
  const a = r.tab();
  const b = r.tab();
  await settle();
  r.servers[0]?.open();
  await settle();
  return { ...r, a, b };
}

describe('SocketEngine — one socket for every tab', () => {
  test('two tabs are one dial', async () => {
    const { servers, a, b } = await upAndRunning();
    expect(servers).toHaveLength(1);
    expect(a.client.connected).toBe(true);
    expect(b.client.connected).toBe(true);
  });

  test('two tabs wanting one channel are ONE subscribe on the socket', async () => {
    const { servers, a, b } = await upAndRunning();
    a.client.holdChannel(orgFeed, { orgId: 'o1' });
    b.client.holdChannel(orgFeed, { orgId: 'o1' });
    await settle();
    expect(channelFrames(servers[0]).map((frame) => frame.op)).toEqual(['add']);
  });

  test('a frame reaches only the tabs that want its channel — routed, never broadcast', async () => {
    const { servers, a, b } = await upAndRunning();
    a.client.holdChannel(orgFeed, { orgId: 'o1' });
    b.client.holdChannel(orgFeed, { orgId: 'o2' });
    await settle();
    servers[0]?.deliver({
      type: 'records',
      v: PROTOCOL_VERSION,
      channel: 'org-feed.o1',
      seq: 1,
      epoch: 'e1',
      adopt: { posts: { p1: { id: 'p1' } } },
    });
    await settle();
    expect(a.store.peek('posts', 'p1')).toEqual({ id: 'p1' });
    expect(b.store.peek('posts', 'p1')).toBeUndefined();
  });

  // The node answers a fresh seat with `replay-gap` so the tab re-reads from after it. A second
  // tab's add never reaches the node — the engine already holds the topic — so the engine gives
  // that tab the same verdict, or a commit between its seed read and its want reached nobody.
  test('a tab joining a channel another tab already holds is told to re-read', async () => {
    const r = rig();
    const reads: string[] = [];
    const a = r.tab();
    await settle();
    r.servers[0]?.open();
    await settle();
    a.client.holdChannel(orgFeed, { orgId: 'o1' });
    await settle();
    r.servers[0]?.deliver({
      type: 'replay-gap',
      v: PROTOCOL_VERSION,
      channel: 'org-feed.o1',
      epoch: 'e1',
    });
    await settle();
    const b = r.tab(async (query) => {
      reads.push(query);
    });
    await settle();
    b.client.holdChannel(orgFeed, { orgId: 'o1' });
    await settle();
    expect(reads).toEqual(['orgFeed']);
    expect(channelFrames(r.servers[0]).map((frame) => frame.op)).toEqual(['add']);
  });

  test('one tab leaving keeps the channel; the last one leaving drops it', async () => {
    const { servers, a, b } = await upAndRunning();
    a.client.holdChannel(orgFeed, { orgId: 'o1' });
    b.client.holdChannel(orgFeed, { orgId: 'o1' });
    await settle();
    a.host.bye();
    await settle();
    expect(channelFrames(servers[0]).map((frame) => frame.op)).toEqual(['add']);
    b.host.bye();
    await settle();
    expect(channelFrames(servers[0]).map((frame) => frame.op)).toEqual(['add', 'drop']);
  });

  test('two tabs holding one live query get their own rows back, by their own sids', async () => {
    const { servers, a, b } = await upAndRunning();
    const left = a.client.subscribeLive({ name: 'feed' }, null);
    b.client.subscribeLive({ name: 'feed' }, null);
    await settle();
    const adds = (servers[0]?.frames() ?? []).filter(
      (frame): frame is SubscribeFrame =>
        frame.type === 'subscribe' && frame.target.kind === 'query',
    );
    expect(new Set(adds.map((frame) => frame.sid)).size).toBe(2);
    const first = adds[0]?.sid ?? '';
    servers[0]?.deliver({
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      sid: first,
      entity: 'posts',
      rows: [{ id: 'p1' }],
      cursor: { qid: 'feed', lsn: '0', ids: ['p1'], at: 0 },
    });
    await settle();
    expect(left.state()).toBe('live');
    expect(left.rows()).toEqual([{ id: 'p1' }]);
  });

  test('a tab silent for three beats is reaped, and its wants released', async () => {
    const { servers, a, b, clock, engineTimers, engine } = await upAndRunning();
    a.client.holdChannel(orgFeed, { orgId: 'o1' });
    await settle();
    expect(engine.ports).toBe(2);
    // Tab b still beats (its hello is the engine's ping); tab a has gone silent — a closed tab.
    for (let beat = 0; beat <= REAP_AFTER_BEATS; beat += 1) {
      clock.advance(1_000);
      b.client.connect();
      // The node answers the engine's own beat, so the real socket stays up throughout.
      servers[0]?.deliver({
        type: 'hello',
        v: PROTOCOL_VERSION,
        buildId: 'b1',
        sessionId: 's1',
        actorId: null,
      });
      await settle();
      engineTimers.fire();
    }
    expect(engine.ports).toBe(1);
    await settle();
    // A reaped tab may only have been throttled (a hidden tab), not closed: it is TOLD, so its
    // client goes offline and redials instead of holding a dead port as a live socket forever.
    expect(a.client.connected).toBe(false);
    expect(b.client.connected).toBe(true);
    // Between the join and the drop the engine's beats repeat the membership (presence).
    const ops = channelFrames(servers[0]).map((frame) => frame.op);
    expect(ops.at(-1)).toBe('drop');
    expect(ops.filter((op) => op === 'drop')).toHaveLength(1);
    expect(servers).toHaveLength(1);
  });

  test('a lost socket closes every tab; each resubscribes from its OWN cursor on the new one', async () => {
    const { servers, a, engineTimers } = await upAndRunning();
    a.client.holdChannel(orgFeed, { orgId: 'o1' });
    await settle();
    servers[0]?.deliver({
      type: 'records',
      v: PROTOCOL_VERSION,
      channel: 'org-feed.o1',
      seq: 4,
      epoch: 'e1',
      adopt: { posts: { p1: { id: 'p1' } } },
    });
    await settle();
    servers[0]?.close(1006);
    await settle();
    expect(a.client.connected).toBe(false);

    a.client.connect(); // the tab's own reconnect timer, fired by hand
    await settle();
    engineTimers.fire(); // the engine's redial
    servers[1]?.open();
    await settle();
    expect(channelFrames(servers[1]).at(-1)?.target).toEqual({
      kind: 'channel',
      channel: 'org-feed',
      params: { orgId: 'o1' },
      since: { epoch: 'e1', seq: 4 },
    });
  });
});
