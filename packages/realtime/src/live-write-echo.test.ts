// A live patch frame names the write that made its change, and a delta resume names every write it
// replays. A page holding its own write still pending settles it in the frame's batch; unnamed, it
// merged the truth UNDER the write's twin and painted the write twice (truth plus overlay). Only
// the writes behind patches THIS subscriber may see are ever named.

import { describe, expect, test } from 'bun:test';
import { type Actor, frozenClock, userActor } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { type ChangeEvent, formatLsn } from './changefeed';
import type { ReconnectBudget } from './cursor';
import type { JsonValue, Row } from './json';
import type { LiveQueryDefinition } from './live-contract';
import { LiveQueryRegistry } from './live-query';
import { patchFromChange } from './matcher-bridge';
import { SyncSocket, type WsLike } from './socket';
import { decode, type Frame } from './sync-protocol';

const ALICE_WRITE = 'a'.repeat(32);
const BOB_WRITE = 'b'.repeat(32);
const clock = frozenClock(new Date('2026-08-09T12:00:00.000Z'));
const input: JsonValue = { orgId: 'o1' };

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
}

const liveFeed: LiveQueryDefinition = {
  name: 'liveFeed',
  entities: ['posts'],
  async snapshot() {
    return { rows: [{ id: 'p1', orgId: 'o1', ownerId: 'alice', likes: 0 }], lsn: formatLsn(1) };
  },
  visible({ actor, row }) {
    return row['ownerId'] === actor?.id;
  },
  matcher() {
    return {
      entities: ['posts'],
      match: (change) => {
        const patch = patchFromChange(change);
        return { patches: patch ? [patch] : [], refill: false };
      },
    };
  },
};

function socketFor(id: string, who: Actor, ws = new FakeWs()): SyncSocket {
  return new SyncSocket({ ws, id, clientBuildId: 'b1', serverBuildId: 'b1', actor: who, clock });
}

const alice = userActor({ id: 'alice', orgId: 'o1' });
const bob = userActor({ id: 'bob', orgId: 'o1' });

const insert = (row: Row, lsn: number, write: string | null): ChangeEvent => ({
  entity: 'posts',
  op: 'insert',
  before: null,
  after: row,
  lsn: formatLsn(BigInt(lsn)),
  txid: String(lsn),
  orgId: 'o1',
  at: clock.now().getTime(),
  write,
});

/** Alice away, Bob keeping the ring alive, then `changes`, then Alice resuming inside the ring. */
async function resumeAfter(
  changes: readonly ChangeEvent[],
  budget?: ReconnectBudget,
): Promise<Frame> {
  const registry = new LiveQueryRegistry({
    source: new RingChangeBuffer(),
    clock,
    ...(budget === undefined ? {} : { budget }),
  }).register(liveFeed);
  const cold = await registry.subscribe({
    socket: socketFor('s-alice-1', alice),
    name: 'liveFeed',
    input,
    sid: 'a1',
  });
  await registry.subscribe({ socket: socketFor('s-bob', bob), name: 'liveFeed', input, sid: 'b1' });
  registry.unsubscribe('s-alice-1', 'a1');
  for (const change of changes) await registry.deliver(change);
  const resumed = await registry.subscribe({
    socket: socketFor('s-alice-2', alice),
    name: 'liveFeed',
    input,
    sid: 'a2',
    cursor: cold.subscription.cursor,
  });
  // As SENT, before a decoder could drop it: the ring's per-patch `write` never reaches the wire.
  const sent = JSON.stringify(resumed.frame);
  expect(sent).not.toContain('"write":');
  return decode(sent);
}

/**
 * Alice and Bob subscribed live, then `changes`: every frame each was sent after subscribing.
 * `desynced` marks both diverged first, so the change reaches them as a re-snapshot.
 */
async function liveThrough(changes: readonly ChangeEvent[], desynced = false) {
  const registry = new LiveQueryRegistry({ source: new RingChangeBuffer(), clock }).register(
    liveFeed,
  );
  const seen = { alice: new FakeWs(), bob: new FakeWs() };
  for (const [sid, who, ws] of [
    ['a1', alice, seen.alice],
    ['b1', bob, seen.bob],
  ] as const) {
    const socket = socketFor(sid, who, ws);
    await registry.subscribe({ socket, name: 'liveFeed', input, sid });
    ws.frames.length = 0;
    if (desynced) socket.markDesynced(sid);
  }
  for (const change of changes) await registry.deliver(change);
  return seen;
}

describe('a live patch frame', () => {
  const mine = { id: 'p2', orgId: 'o1', ownerId: 'alice', likes: 0 };

  test('names the keyed write that made its change, read back off the wire', async () => {
    const { alice } = await liveThrough([insert(mine, 2, ALICE_WRITE)]);
    expect(alice.frames).toHaveLength(1);
    expect(alice.frames[0]).toMatchObject({ type: 'patch', sid: 'a1', writes: [ALICE_WRITE] });
    const [frame] = alice.frames;
    expect(frame?.type === 'patch' && frame.patches.every((patch) => !('write' in patch))).toBe(
      true,
    );
  });

  test('of an unkeyed change is the frame it always was, with no writes field', async () => {
    const { alice } = await liveThrough([insert(mine, 2, null)]);
    expect(alice.frames[0]?.type).toBe('patch');
    expect('writes' in (alice.frames[0] ?? {})).toBe(false);
  });

  test('is never sent to a subscriber the gate shows nothing, so neither is its digest', async () => {
    const { bob } = await liveThrough([insert(mine, 2, ALICE_WRITE)]);
    expect(JSON.stringify(bob.frames)).not.toContain(ALICE_WRITE);
  });

  test('a write that is not a digest is dropped, never sent: the decoder would refuse the frame', async () => {
    const { alice } = await liveThrough([insert(mine, 2, 'likePost:the-raw-key')]);
    expect(alice.frames).toHaveLength(1);
    expect('writes' in (alice.frames[0] ?? {})).toBe(false);
  });
});

describe('a delta resume', () => {
  test('names the write behind each patch it replays to this subscriber', async () => {
    const frame = await resumeAfter([
      insert({ id: 'p2', orgId: 'o1', ownerId: 'alice', likes: 0 }, 2, ALICE_WRITE),
      insert({ id: 'p3', orgId: 'o1', ownerId: 'alice', likes: 0 }, 3, null),
    ]);
    expect(frame.type).toBe('patch');
    expect(frame.type === 'patch' && frame.writes).toEqual([ALICE_WRITE]);
    // The digest names the write; the patches themselves stay the wire shape they always were.
    expect(frame.type === 'patch' && frame.patches.every((patch) => !('write' in patch))).toBe(
      true,
    );
  });

  test('a write behind a patch the gate withheld is never named to this subscriber', async () => {
    const frame = await resumeAfter([
      insert({ id: 'p9', orgId: 'o1', ownerId: 'bob', likes: 0 }, 2, BOB_WRITE),
    ]);
    expect(frame.type).toBe('patch');
    expect(frame.type === 'patch' && frame.patches).toEqual([]);
    expect(frame.type === 'patch' && 'writes' in frame).toBe(false);
  });

  test('one write behind several replayed patches is named once', async () => {
    const frame = await resumeAfter([
      insert({ id: 'p2', orgId: 'o1', ownerId: 'alice', likes: 0 }, 2, ALICE_WRITE),
      insert({ id: 'p3', orgId: 'o1', ownerId: 'alice', likes: 0 }, 3, ALICE_WRITE),
    ]);
    expect(frame.type === 'patch' && frame.writes).toEqual([ALICE_WRITE]);
  });
});

// A snapshot is server truth for the whole window, so a write it already holds is settled by it
// exactly as a patch settles one — named only where this subscriber may see the row it wrote.
describe('a snapshot frame', () => {
  const mine = { id: 'p2', orgId: 'o1', ownerId: 'alice', likes: 0 };

  test('a re-snapshot a keyed change caused names that write to the subscriber who sees it', async () => {
    const { alice, bob } = await liveThrough([insert(mine, 2, ALICE_WRITE)], true);
    expect(alice.frames).toHaveLength(1);
    expect(alice.frames[0]).toMatchObject({ type: 'snapshot', sid: 'a1', writes: [ALICE_WRITE] });
    // Bob was re-snapshotted too, out of rows that do not hold Alice's: never told of her write.
    expect(bob.frames[0]?.type).toBe('snapshot');
    expect(JSON.stringify(bob.frames)).not.toContain(ALICE_WRITE);
  });

  test('a re-snapshot after an unkeyed change names nothing', async () => {
    const { alice } = await liveThrough([insert(mine, 2, null)], true);
    expect(alice.frames[0]?.type).toBe('snapshot');
    expect('writes' in (alice.frames[0] ?? {})).toBe(false);
  });

  test('a resume past its budget falls back to a snapshot that still names the writes', async () => {
    const tight: ReconnectBudget = {
      maxPatches: 0,
      maxLagMs: 60_000,
      snapshotCost: 1,
      patchCost: 1,
    };
    const frame = await resumeAfter(
      [
        insert(mine, 2, ALICE_WRITE),
        insert({ id: 'p9', orgId: 'o1', ownerId: 'bob', likes: 0 }, 3, BOB_WRITE),
      ],
      tight,
    );
    expect(frame.type).toBe('snapshot');
    expect(frame.type === 'snapshot' && frame.writes).toEqual([ALICE_WRITE]);
  });
});

test('the retained ring keeps the write beside the pre-policy patch, for the resume to read', () => {
  const ring = new RingChangeBuffer();
  ring.floorAt('q', formatLsn(1));
  ring.append('q', { op: 'insert', id: 'p2', row: {}, lsn: formatLsn(2), write: ALICE_WRITE });
  ring.append('q', { op: 'insert', id: 'p3', row: {}, lsn: formatLsn(3) });
  expect(ring.since('q', formatLsn(1))?.map((patch) => patch.write)).toEqual([
    ALICE_WRITE,
    undefined,
  ]);
});

// The type IS the enforcement: a producer that forgets the field fails `tsc`, it does not ship a
// page that paints truth plus overlay. `@ts-expect-error` turns red here the day it goes optional.
test('ChangeEvent.write is required: "no keyed write" is spelled null, never left out', () => {
  // @ts-expect-error — `write` is missing
  const unnamed: ChangeEvent = {
    entity: 'posts',
    op: 'insert',
    before: null,
    after: { id: 'p1' },
    lsn: formatLsn(1),
    txid: '1',
    orgId: 'o1',
    at: 0,
  };
  expect(unnamed.write).toBeUndefined();
});
