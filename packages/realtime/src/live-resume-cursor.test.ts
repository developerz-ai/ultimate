// One claim: the cursor a DELTA RESUME seats is advanced over the rows this subscriber may see,
// never over the retained window — which is pre-policy and holds every other actor's rows.
//
// `subscriber-gate.ts` reads `held.has(patch.id)` off that cursor to decide whether a refused row
// is one the subscriber is holding and must be told about. Seated pre-policy, the answer is yes for
// rows it was never sent, so the one branch that exists to close the leak becomes the leak: a
// `delete` frame carrying another tenant's row id and the instant it went.

import { expect, test } from 'bun:test';
import { type Actor, frozenClock, userActor } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { type ChangeEvent, formatLsn } from './changefeed';
import type { JsonValue, Row } from './json';
import type { LiveQueryDefinition } from './live-contract';
import { LiveQueryRegistry } from './live-query';
import { patchFromChange } from './matcher-bridge';
import { SyncSocket, type WsLike } from './socket';
import { decode, type Frame } from './sync-protocol';

const actor = (id: string): Actor => userActor({ id, orgId: 'o1' });

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

/** Alice's row and Bob's row, on one query id, separated only by `visible`. */
const rows: Row[] = [
  { id: 'p1', orgId: 'o1', ownerId: 'alice', title: 'alice draft' },
  { id: 'p2', orgId: 'o1', ownerId: 'bob', title: 'bob draft' },
];

const liveFeed: LiveQueryDefinition = {
  name: 'liveFeed',
  entities: ['posts'],
  async snapshot() {
    return { rows, lsn: formatLsn(1) };
  },
  visible({ actor: subject, row }) {
    return row['ownerId'] === subject?.id;
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

const clock = frozenClock(new Date('2026-08-09T12:00:00.000Z'));

function socketFor(id: string, who: Actor): { socket: SyncSocket; ws: FakeWs } {
  const ws = new FakeWs();
  const socket = new SyncSocket({
    ws,
    id,
    clientBuildId: 'b1',
    serverBuildId: 'b1',
    actor: who,
    clock,
  });
  return { socket, ws };
}

const change = (op: 'insert' | 'delete', row: Row, lsn: number): ChangeEvent => ({
  entity: 'posts',
  op,
  before: op === 'delete' ? row : null,
  after: op === 'delete' ? null : row,
  lsn: formatLsn(BigInt(lsn)),
  txid: String(lsn),
  orgId: 'o1',
  at: clock.now().getTime(),
});

const BOB_ROW: Row = { id: 'p3', orgId: 'o1', ownerId: 'bob', title: 'bob secret' };
const input: JsonValue = { orgId: 'o1' };

/**
 * Alice cold-subscribes, Bob keeps the entry (and therefore the retained ring) alive, a row is
 * inserted for Bob while Alice is away, and Alice resumes inside the retain window.
 */
async function resumeAliceAfterBobsInsert(): Promise<{
  registry: LiveQueryRegistry;
  alice: { socket: SyncSocket; ws: FakeWs };
  cursorIds: readonly string[];
}> {
  const registry = new LiveQueryRegistry({
    source: new RingChangeBuffer(),
    clock,
  }).register(liveFeed);
  const first = socketFor('s-alice-1', actor('alice'));
  const bob = socketFor('s-bob', actor('bob'));

  const cold = await registry.subscribe({
    socket: first.socket,
    name: 'liveFeed',
    input,
    sid: 'a1',
  });
  await registry.subscribe({ socket: bob.socket, name: 'liveFeed', input, sid: 'b1' });
  // Alice holds her own row and nothing else. This is what a correct resume must preserve.
  expect([...cold.subscription.cursor.ids]).toEqual(['p1']);

  await registry.deliver(change('insert', BOB_ROW, 2));
  // Alice's socket goes; Bob's keeps the entry and its ring, which is what makes the delta path
  // reachable at all — `unsubscribe` forgets the ring only when the last subscriber leaves.
  registry.unsubscribe(first.socket.id, 'a1');

  const alice = socketFor('s-alice-2', actor('alice'));
  const resumed = await registry.subscribe({
    socket: alice.socket,
    name: 'liveFeed',
    input,
    sid: 'a2',
    cursor: cold.subscription.cursor,
  });
  expect(resumed.frame.type).toBe('patch');
  return { registry, alice, cursorIds: resumed.subscription.cursor.ids };
}

test('a delta resume never seats an id this subscriber may not see', async () => {
  const { cursorIds } = await resumeAliceAfterBobsInsert();
  expect([...cursorIds]).toEqual(['p1']);
});

test('a row the subscriber never held is not announced to it when it is deleted', async () => {
  const { registry, alice } = await resumeAliceAfterBobsInsert();
  alice.ws.frames.length = 0;

  await registry.deliver(change('delete', BOB_ROW, 3));

  const leaked = alice.ws.frames.filter((frame) => JSON.stringify(frame).includes('p3'));
  expect(leaked).toEqual([]);
});
