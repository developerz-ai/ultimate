// Multi-node realtime over a real nats-server: two `sync` nodes, each on its own bus connection and
// its own port, the WAL replicator on a third, and pages on real websockets. Proves what one node
// over the in-process bus cannot: a publish on one node is delivered by another, in order; a page
// whose node dies resumes on a survivor from its CURSOR (a delta replay, no snapshot) with nothing
// lost and nothing twice; a restarted node serves it a snapshot; and a node that misses changes on
// the bus detects the gap and re-serves its pages. Loss and duplication are read off the frames
// the page received, never off its state.
//
// Skips unless a JetStream-enabled server is configured:
//
//   TEST_NATS_URL=nats://localhost:4222 bun test ./packages/realtime/src/multi-node.live.test.ts

import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { logger } from '@ultimat3/core';
import { channel } from './channel-decl';
import { clearChannels } from './channel-registry';
import {
  type FleetNode,
  feedQuery,
  openPage,
  type Page,
  startNode,
  startReplicator,
  Table,
  waitFor,
} from './multi-node-rig-fixture';
import { parseNatsUrl } from './nats-client';
import { relayTo, throughRelay } from './nats-relay-fixture';
import { OPEN_POLICY } from './policy-fake-fixture';
import type { Frame } from './sync-protocol';

const url = Bun.env['TEST_NATS_URL'];
/** This evaluation's own names: the server is shared, and another run's traffic is not ours. */
const RUN = crypto.randomUUID().slice(0, 8);

const cleanup: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const step of cleanup.reverse()) await step();
  clearChannels();
});

/** What one page's live subscription was sent, in arrival order. */
interface Audit {
  /** `snapshot` and `patch` frames, in order, by kind. */
  readonly kinds: readonly string[];
  /** Every patch's lsn, in arrival order. */
  readonly lsns: readonly string[];
  /** A patch at or below the position the page already held: delivered twice, or out of order. */
  readonly backwards: readonly string[];
}

function audit(frames: readonly Frame[]): Audit {
  const kinds: string[] = [];
  const lsns: string[] = [];
  const backwards: string[] = [];
  let held = '';
  for (const frame of frames) {
    if (frame.type === 'snapshot') {
      kinds.push('snapshot');
      // A snapshot may only move the page forwards: one behind what it held would replay history.
      if (frame.cursor.lsn < held) backwards.push(`snapshot@${frame.cursor.lsn}`);
      held = frame.cursor.lsn;
    }
    if (frame.type === 'patch') {
      kinds.push('patch');
      for (const patch of frame.patches) {
        lsns.push(patch.lsn);
        if (patch.lsn <= held) backwards.push(patch.lsn);
        held = patch.lsn;
      }
    }
  }
  return { kinds, lsns, backwards };
}

/** The page shows exactly what the table holds, row for row. */
const shows = (page: Page, table: Table): boolean =>
  JSON.stringify(page.ids()) === JSON.stringify(table.ids()) &&
  page.live.rows().every((row) => {
    const id = String((row as { id: unknown }).id);
    return JSON.stringify(row) === JSON.stringify(table.rows.get(id));
  });

const busUrl = (): string => url ?? '';

async function fleet(name: string) {
  const table = new Table(`mn_${name}_${RUN}`);
  const query = feedQuery(table, `multiNode_${name}_${RUN}`);
  const replicator = await startReplicator(busUrl());
  cleanup.push(replicator.stop);
  const node = async (bus = busUrl()): Promise<FleetNode> => {
    const started = await startNode(bus, query);
    cleanup.push(started.kill);
    return started;
  };
  /** Commits and publishes in order; each publish awaited, as the pump awaits it. */
  const write = async (from: number, to: number): Promise<void> => {
    for (let n = from; n <= to; n += 1) {
      const id = `r${n % 7}`;
      const op = table.rows.has(id) ? (n % 3 === 0 ? 'delete' : 'update') : 'insert';
      await replicator.publish(table.commit(op, id, op === 'delete' ? {} : { n }));
    }
  };
  const page = (target: () => string): Page => {
    const opened = openPage(target, query.name);
    cleanup.push(opened.close);
    return opened;
  };
  return { table, node, write, page };
}

describe.skipIf(url === undefined)('two sync nodes over a real bus', () => {
  test('an event published on one node reaches a member on the other, in publish order', async () => {
    const f = await fleet('events');
    const a = await f.node();
    const b = await f.node();
    const room = channel(`mn-room-${RUN}`, {
      params: ['orgId'],
      catchUp: { name: `mnRoomRead${RUN}` },
      policy: OPEN_POLICY,
      events: true,
    });
    const member = f.page(() => b.url);
    const events: unknown[] = [];
    const membership = member.client.holdChannel(
      room,
      { orgId: 'o1' },
      { onEvent: (event) => events.push(event['n']) },
    );
    await waitFor(() => membership.state() === 'live');
    expect(membership.state()).toBe('live');

    // Published through node A's hub: A holds no member, so only the bus can carry them to B.
    for (let n = 1; n <= 50; n += 1) await a.hub.publishEvent(room, { orgId: 'o1' }, { n });
    await waitFor(() => events.length === 50);

    expect(events).toEqual(Array.from({ length: 50 }, (_, at) => at + 1));
    expect(member.errors).toEqual([]);
  }, 30_000);

  test('a change the replicator publishes reaches pages on both nodes, each in lsn order', async () => {
    const f = await fleet('fanout');
    const a = await f.node();
    const b = await f.node();
    const onA = f.page(() => a.url);
    const onB = f.page(() => b.url);
    await waitFor(() => onA.live.state() === 'live' && onB.live.state() === 'live');

    await f.write(1, 40);
    await waitFor(() => shows(onA, f.table) && shows(onB, f.table));

    for (const page of [onA, onB]) {
      expect(shows(page, f.table)).toBe(true);
      const seen = audit(page.frames);
      expect(seen.backwards).toEqual([]);
      // One snapshot at subscribe, then every one of the 40 commits as a patch, none twice.
      expect(seen.kinds.filter((kind) => kind === 'snapshot')).toHaveLength(1);
      expect(seen.lsns).toHaveLength(40);
      expect(page.errors).toEqual([]);
    }
  }, 30_000);

  test('a node killed mid-stream: its page resumes on the survivor from its cursor, nothing lost and nothing twice', async () => {
    const f = await fleet('kill');
    const a = await f.node();
    const b = await f.node();
    let dial = a.url;
    const moving = f.page(() => dial);
    // B serves the same query to a page of its own, so B's change buffer holds the window.
    const staying = f.page(() => b.url);
    await waitFor(() => moving.live.state() === 'live' && staying.live.state() === 'live');
    await f.write(1, 20);
    await waitFor(() => shows(moving, f.table) && shows(staying, f.table));
    expect(shows(moving, f.table)).toBe(true);

    // Mid-stream: A dies with no goodbye while the replicator keeps publishing. The page is told
    // nothing; it finds its socket gone and redials — onto B, the load balancer's answer.
    const writing = f.write(21, 60);
    await waitFor(() => audit(moving.frames).lsns.length >= 25, 2_000);
    dial = b.url;
    const dialled = moving.dials();
    await a.kill();
    await writing;
    await waitFor(() => moving.dials() > dialled && shows(moving, f.table), 2_000);

    expect(moving.dials()).toBe(dialled + 1);
    expect(shows(moving, f.table)).toBe(true);
    const seen = audit(moving.frames);
    expect(seen.backwards).toEqual([]);
    // The cursor was inside B's retained window: replayed as patches, never re-snapshotted, and
    // every commit arrived exactly once across the two nodes.
    expect(seen.kinds.filter((kind) => kind === 'snapshot')).toHaveLength(1);
    expect(seen.lsns).toHaveLength(60);
    expect(new Set(seen.lsns).size).toBe(60);
    expect(moving.errors).toEqual([]);
  }, 60_000);

  test('a node restarted empty serves a returning page one snapshot, and the stream goes on from it', async () => {
    const f = await fleet('restart');
    let a = await f.node();
    let dial = a.url;
    const page = f.page(() => dial);
    await waitFor(() => page.live.state() === 'live');
    await f.write(1, 15);
    await waitFor(() => shows(page, f.table));
    const dialled = page.dials();

    // Killed, written past while it is down, and started again on a new port: no window, no
    // buffer, no bus history. The page's cursor names a window this node never held.
    await a.kill();
    await f.write(16, 30);
    a = await f.node();
    dial = a.url;
    await waitFor(() => page.dials() > dialled && shows(page, f.table), 2_000);
    await f.write(31, 45);
    await waitFor(() => shows(page, f.table), 2_000);

    expect(shows(page, f.table)).toBe(true);
    const seen = audit(page.frames);
    expect(seen.backwards).toEqual([]);
    // Subscribe, then the restarted node's answer to the cursor: one snapshot holding 16–30.
    expect(seen.kinds.filter((kind) => kind === 'snapshot')).toHaveLength(2);
    expect(new Set(seen.lsns).size).toBe(seen.lsns.length);
    // 1–15 before the kill and 31–45 after the restart, as patches; 16–30 only in the snapshot.
    expect(seen.lsns).toHaveLength(30);
    expect(page.errors).toEqual([]);
  }, 60_000);

  test('a node that misses changes on the bus detects it and re-serves its page with no later write', async () => {
    const warn = spyOn(logger, 'warn');
    const target = parseNatsUrl(busUrl());
    const relay = await relayTo(target.host, target.port);
    cleanup.push(() => relay.stop());
    const f = await fleet('gap');
    // Only this node's bus goes through the relay: the rest of the fleet never sees the outage.
    const cut = await f.node(throughRelay(busUrl(), relay.port));
    const page = f.page(() => cut.url);
    await waitFor(() => page.live.state() === 'live');
    await f.write(1, 10);
    await waitFor(() => shows(page, f.table));
    expect(shows(page, f.table)).toBe(true);
    const reconnected = (): boolean =>
      warn.mock.calls.some(([message]) => message === 'live.bus_reconnected');

    try {
      relay.cut();
      // Published while the node is off the bus: core NATS keeps none of them for it. Then
      // nothing more: the query is quiet, so no later change is there to notice the hole by.
      await f.write(11, 30);
      await waitFor(reconnected, 2_000);
      await waitFor(() => shows(page, f.table), 2_000);

      expect(reconnected()).toBe(true);
      expect(shows(page, f.table)).toBe(true);
      const seen = audit(page.frames);
      expect(seen.backwards).toEqual([]);
      // The repair is a snapshot: the changes the node never heard are replayable from nowhere.
      expect(seen.kinds.filter((kind) => kind === 'snapshot')).toHaveLength(2);
      expect(page.errors).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  }, 30_000);
});
