// A patch every subscriber may see whole is encoded once per change, and the bytes each subscriber
// receives are exactly the bytes its own per-subscriber frame would have been (finding R6, plan 101
// `13-realtime.md`). A subscriber whose gate rewrote the list is never handed the shared encoding.

import { describe, expect, spyOn, test } from 'bun:test';
import { systemClock, userActor } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import type { ChangeEvent } from './changefeed';
import { makeCursor } from './cursor';
import type { LiveRow } from './json';
import type { LiveQueryDefinition } from './live-contract';
import { type FanoutDeps, fanoutChange, patchFrame } from './live-fanout';
import { encodePatchFrame } from './live-patch-encode';
import type { BridgeResult } from './matcher-bridge';
import { type QueryEntry, queryEntry } from './query-window';
import { SocketRegistry, SyncSocket, type WsLike } from './socket';
import { SubscriberGate } from './subscriber-gate';
import { encode } from './sync-protocol';

class RawWs implements WsLike {
  readonly raw: string[] = [];
  send(data: string): number {
    this.raw.push(data);
    return data.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}

const seated: readonly LiveRow[] = [
  { id: 'p1', orgId: 'o1', likes: 0 },
  { id: 'p2', orgId: 'o1', likes: 0 },
];

const patched: BridgeResult = {
  patches: [{ op: 'update', id: 'p1', row: { id: 'p1', likes: 1 }, lsn: '1' }],
  refill: false,
};

const change: ChangeEvent = {
  table: 'posts',
  op: 'update',
  before: { id: 'p1', orgId: 'o1', likes: 0 },
  after: { id: 'p1', orgId: 'o1', likes: 1 },
  lsn: '2',
  txid: '2',
  at: 0,
  orgId: 'o1',
  write: null,
};

/** An entry whose window has landed, whose matcher answers `patched`, under the given row rule. */
function rig(visible: LiveQueryDefinition['visible']): { entry: QueryEntry; deps: FanoutDeps } {
  const definition: LiveQueryDefinition = {
    name: 'liveFeed',
    entities: ['posts'],
    snapshot: async () => ({ rows: seated, lsn: '' }),
    visible,
    matcher: () => ({ entities: ['posts'], match: () => patched }),
  };
  const input = { orgId: 'o1' };
  const entry = queryEntry('liveFeed:1', definition, input, definition.matcher(input));
  entry.rows = seated;
  entry.generation = 1;
  entry.applied = 1;
  const deps = { gate: new SubscriberGate({}), source: new RingChangeBuffer(), clock: systemClock };
  return { entry, deps };
}

/** One subscriber on its own socket, holding the whole window, as a landed snapshot leaves it. */
function seat(entry: QueryEntry, sid: string, actorId: string): RawWs {
  const ws = new RawWs();
  const socket = new SyncSocket({
    ws,
    clientBuildId: 'b',
    serverBuildId: 'b',
    actor: userActor({ id: actorId, orgId: 'o1' }),
  });
  new SocketRegistry().add(socket);
  entry.subscribers.set(sid, {
    sid,
    qid: entry.qid,
    socket,
    input: entry.input,
    definition: entry.definition,
    cursor: makeCursor(entry.qid, entry.lsn, entry.rows, 0),
  });
  return ws;
}

describe('a patch every subscriber may see whole is encoded once', () => {
  test('each subscriber gets the bytes its own per-subscriber frame would have been', async () => {
    const { entry, deps } = rig(() => true);
    // Sids a JSON string must escape: the shared spelling may not splice them in raw.
    const seats = ['s"1', 'sé2', 's3'].map((sid) => ({ sid, ws: seat(entry, sid, 'alice') }));
    const stringify = spyOn(JSON, 'stringify');
    try {
      expect((await fanoutChange(deps, entry, change)).sent).toBe(3);
      // The patch list crossed `JSON.stringify` once for three subscribers, not once each.
      const lists = stringify.mock.calls.filter(([value]) => value === patched.patches);
      expect(lists).toHaveLength(1);
    } finally {
      stringify.mockRestore();
    }
    for (const { sid, ws } of seats) {
      expect(ws.raw).toEqual([encode(patchFrame(sid, patched.patches, '2', []))]);
    }
  });

  test('a write named on the frame is spelled as the unshared frame spells it', () => {
    const writes = ['w:1', 'w"2'];
    const text = encodePatchFrame('sid-1', JSON.stringify(patched.patches), '00ff', writes);
    expect(text).toBe(encode(patchFrame('sid-1', patched.patches, '00ff', writes)));
  });

  test('a subscriber whose gate rewrote the list is encoded on its own', async () => {
    const { entry, deps } = rig(({ actor }) => actor?.id === 'alice');
    const alice = seat(entry, 'a', 'alice');
    const bob = seat(entry, 'b', 'bob');
    expect((await fanoutChange(deps, entry, change)).sent).toBe(2);
    expect(alice.raw).toEqual([encode(patchFrame('a', patched.patches, '2', []))]);
    // Bob held p1 and may no longer see it: his list is a withdrawal, never alice's update.
    const withdrawn = [{ op: 'delete', id: 'p1', row: null, lsn: '1' }] as const;
    expect(bob.raw).toEqual([encode(patchFrame('b', withdrawn, '2', []))]);
  });
});
