// A resume trusts `cursor.ids` only as far as the server signed them (#1280). The ids are client
// data, and `subscriber-gate.ts` reads them as "rows this subscriber holds": a forged id gets that
// row's `delete` — its existence and the instant it went. A sig that does not match is a cold
// start; a cursor with none is the legacy path, counted. And the designed case stays whole: a row
// the subscriber really held, revoked while it was away, is still withdrawn.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  type Actor,
  configureCursorSigning,
  frozenClock,
  resetCursorSigning,
  userActor,
} from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { type ChangeEvent, formatLsn } from './changefeed';
import type { LiveCursor } from './cursor';
import { cursorVerdict } from './cursor-sign';
import { liveFeed as pageFeed, pageHarness, querySid, resetPage } from './hooks-fixture';
import type { JsonValue, LiveRow } from './json';
import type { LiveQueryDefinition } from './live-contract';
import { LiveQueryRegistry } from './live-query';
import { patchFromChange } from './matcher-bridge';
import { SyncSocket, type WsLike } from './socket';
import { decode, type Frame } from './sync-protocol';

afterEach(() => {
  resetCursorSigning();
  resetPage();
});

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

const P1: LiveRow = { id: 'p1', orgId: 'o1', ownerId: 'alice', title: 'alice draft' };
const P2: LiveRow = { id: 'p2', orgId: 'o1', ownerId: 'bob', title: 'bob draft' };
const SHARED: LiveRow = { id: 'p5', orgId: 'o1', ownerId: 'bob', title: 'shared with alice' };

const clock = frozenClock(new Date('2026-11-27T12:00:00.000Z'));
const input: JsonValue = { orgId: 'o1' };
const otherInput: JsonValue = { orgId: 'o1', tab: 'other' };

/** One world per test: its rows, the grants `visible` reads, and a registry over them. */
function world(): {
  registry: LiveQueryRegistry;
  grants: Set<string>;
  unsigned: unknown[];
  refused: unknown[];
} {
  const grants = new Set<string>(['alice:p5']);
  const liveFeed: LiveQueryDefinition = {
    name: 'liveFeed',
    entities: ['posts'],
    async snapshot() {
      return { rows: [P1, P2, SHARED], lsn: formatLsn(1) };
    },
    visible({ actor: subject, row }) {
      return row['ownerId'] === subject?.id || grants.has(`${subject?.id}:${row.id}`);
    },
    matcher() {
      return {
        entities: ['posts'],
        match: (event) => {
          const patch = patchFromChange(event);
          return { patches: patch ? [patch] : [], refill: false };
        },
      };
    },
  };
  const unsigned: unknown[] = [];
  const refused: unknown[] = [];
  const registry = new LiveQueryRegistry({
    source: new RingChangeBuffer(),
    clock,
    onUnsignedCursor: (event) => unsigned.push(event),
    onCursorRefused: (event) => refused.push(event),
  }).register(liveFeed);
  return { registry, grants, unsigned, refused };
}

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

const change = (op: ChangeEvent['op'], row: LiveRow, lsn: number): ChangeEvent => ({
  table: 'posts',
  op,
  before: op === 'insert' ? null : row,
  after: op === 'delete' ? null : row,
  lsn: formatLsn(BigInt(lsn)),
  txid: String(lsn),
  orgId: 'o1',
  at: clock.now().getTime(),
  write: null,
});

const mentions = (frames: readonly Frame[], id: string): Frame[] =>
  frames.filter((frame) => JSON.stringify(frame).includes(`"${id}"`));

type Registry = LiveQueryRegistry;

/** Alice subscribes cold and leaves; Bob stays, so the entry and its retained ring survive. */
async function aliceAway(registry: Registry): Promise<{ cursor: LiveCursor; bobs: LiveCursor }> {
  const first = socketFor('s-alice-1', actor('alice'));
  const bob = socketFor('s-bob', actor('bob'));
  const cold = await registry.subscribe({
    socket: first.socket,
    name: 'liveFeed',
    input,
    sid: 'a1',
  });
  const bobs = await registry.subscribe({
    socket: bob.socket,
    name: 'liveFeed',
    input,
    sid: 'b1',
  });
  const frame = cold.frame;
  if (frame.type !== 'snapshot') return expect.unreachable('a cold start is a snapshot');
  registry.unsubscribe(first.socket.id, 'a1');
  return { cursor: frame.cursor, bobs: bobs.subscription.cursor };
}

async function resumeAlice(
  registry: Registry,
  cursor: LiveCursor,
): Promise<{ frame: Frame; ws: FakeWs; seated: readonly string[] }> {
  const alice = socketFor('s-alice-2', actor('alice'));
  const resumed = await registry.subscribe({
    socket: alice.socket,
    name: 'liveFeed',
    input,
    sid: 'a2',
    cursor,
  });
  return { frame: resumed.frame, ws: alice.ws, seated: resumed.subscription.cursor.ids };
}

describe('a signed cursor', () => {
  test('every cursor the node hands out carries a sig', async () => {
    const { registry } = world();
    const { cursor, bobs } = await aliceAway(registry);
    expect(typeof cursor.sig).toBe('string');
    expect(typeof bobs.sig).toBe('string');
    expect(bobs.sig).not.toBe(cursor.sig);
  });

  test('a resume that falls back to a snapshot seats a cursor signed for it', async () => {
    const { registry } = world();
    const { cursor } = await aliceAway(registry);
    // Signed and honest, and older than the lag budget: `at` is not bound, so it still verifies.
    const { frame } = await resumeAlice(registry, { ...cursor, at: 0 });

    if (frame.type !== 'snapshot') return expect.unreachable(`resumed with a ${frame.type}`);
    const who = { sid: 'a2', actor: actor('alice') };
    expect(cursorVerdict(frame.cursor, who)).toBe('signed');
    expect(registry.subscription('s-alice-2', 'a2')?.cursor).toEqual(frame.cursor);
    expect(registry.cursorsRefused).toBe(0);
  });

  test('a repair snapshot seats a cursor signed for the subscriber it repairs', async () => {
    const { registry } = world();
    const alice = socketFor('s-alice-1', actor('alice'));
    await registry.subscribe({ socket: alice.socket, name: 'liveFeed', input, sid: 'a1' });
    registry.invalidate();

    expect(await registry.repairMarked()).toBe(1);

    const frame = alice.ws.frames.at(-1);
    if (frame?.type !== 'snapshot') return expect.unreachable('a repair is a snapshot');
    expect(cursorVerdict(frame.cursor, { sid: 'a1', actor: actor('alice') })).toBe('signed');
    expect(cursorVerdict(frame.cursor, { sid: 'a1', actor: actor('bob') })).toBe('refused');
  });

  test('resumes from the delta, counted nowhere, and is signed again where it lands', async () => {
    const { registry, unsigned, refused } = world();
    const { cursor } = await aliceAway(registry);
    await registry.deliver(change('insert', { ...P1, id: 'p4' }, 2));

    const { frame, seated } = await resumeAlice(registry, cursor);

    if (frame.type !== 'patch') return expect.unreachable(`resumed with a ${frame.type}`);
    expect([...seated]).toEqual(['p1', 'p5', 'p4']);
    expect(typeof frame.sig).toBe('string');
    expect(frame.sig).not.toBe(cursor.sig);
    expect([registry.unsignedCursors, registry.cursorsRefused]).toEqual([0, 0]);
    expect([unsigned, refused]).toEqual([[], []]);
  });

  test('a row genuinely held, revoked while away, is still withdrawn', async () => {
    const { registry, grants } = world();
    const { cursor } = await aliceAway(registry);
    expect([...cursor.ids]).toEqual(['p1', 'p5']);
    grants.delete('alice:p5');
    await registry.deliver(change('update', { ...SHARED, title: 'edited after the revoke' }, 2));

    const { frame, seated } = await resumeAlice(registry, cursor);

    if (frame.type !== 'patch') return expect.unreachable(`resumed with a ${frame.type}`);
    expect(frame.patches).toEqual([{ op: 'delete', id: 'p5', row: null, lsn: formatLsn(2n) }]);
    expect([...seated]).toEqual(['p1']);
  });

  test('an OLD cursor of its own is still a position it really held', async () => {
    const { registry } = world();
    const { cursor } = await aliceAway(registry);
    await registry.deliver(change('insert', { ...P1, id: 'p4' }, 2));
    await resumeAlice(registry, cursor);

    const again = socketFor('s-alice-3', actor('alice'));
    const replayed = await registry.subscribe({
      socket: again.socket,
      name: 'liveFeed',
      input,
      sid: 'a3',
      cursor,
    });
    expect(replayed.frame.type).toBe('patch');
    expect(registry.cursorsRefused).toBe(0);
  });
});

describe('a cursor whose sig does not match cold-starts', () => {
  /** The resume answered a snapshot of what Alice may see, and seated exactly that. */
  async function expectColdStart(registry: Registry, forged: LiveCursor): Promise<FakeWs> {
    const { frame, seated, ws } = await resumeAlice(registry, forged);
    if (frame.type !== 'snapshot') return expect.unreachable(`a forged cursor got a ${frame.type}`);
    expect(frame.rows.map((row) => row.id)).toEqual(['p1', 'p5']);
    expect([...seated]).toEqual(['p1', 'p5']);
    expect([...frame.cursor.ids]).toEqual(['p1', 'p5']);
    expect(registry.cursorsRefused).toBe(1);
    expect(registry.unsignedCursors).toBe(0);
    return ws;
  }

  test('a forged id gets no delete — not from the retained window, not from a later change', async () => {
    const { registry, refused } = world();
    const { cursor } = await aliceAway(registry);
    const forged = { ...cursor, ids: [...cursor.ids, 'p2', 'p6'] };
    // One of Bob's rows goes while Alice is away (replayed from the ring), one after she is back.
    await registry.deliver(change('delete', P2, 2));

    const ws = await expectColdStart(registry, forged);
    await registry.deliver(change('insert', { ...P2, id: 'p6' }, 3));
    await registry.deliver(change('delete', { ...P2, id: 'p6' }, 4));

    expect(mentions(ws.frames, 'p2')).toEqual([]);
    expect(mentions(ws.frames, 'p6')).toEqual([]);
    expect(refused).toEqual([{ qid: cursor.qid, sid: 'a2', actorId: 'alice' }]);
  });

  test("another subscriber's cursor, replayed whole", async () => {
    const { registry } = world();
    const { bobs } = await aliceAway(registry);
    expect([...bobs.ids]).toEqual(['p2', 'p5']);
    await registry.deliver(change('delete', P2, 2));

    const ws = await expectColdStart(registry, bobs);
    expect(mentions(ws.frames, 'p2')).toEqual([]);
  });

  test("another window's sig over this window's qid", async () => {
    const { registry } = world();
    const { cursor } = await aliceAway(registry);
    const elsewhere = socketFor('s-alice-other', actor('alice'));
    const other = await registry.subscribe({
      socket: elsewhere.socket,
      name: 'liveFeed',
      input: otherInput,
      sid: 'x1',
    });
    const others = other.subscription.cursor;
    // Same subscriber, same lsn, same ids: the window is the only thing that differs.
    expect([others.lsn, [...others.ids]]).toEqual([cursor.lsn, [...cursor.ids]]);
    expect(others.qid).not.toBe(cursor.qid);

    await expectColdStart(registry, { ...others, qid: cursor.qid });
  });

  test('an lsn rolled back under the sig of a later position', async () => {
    const { registry } = world();
    const { cursor } = await aliceAway(registry);
    await registry.deliver(change('delete', P1, 2));
    const later = await resumeAlice(registry, cursor);
    if (later.frame.type !== 'patch') return expect.unreachable('the honest resume is a delta');
    const sig = later.frame.sig;
    if (sig === undefined) return expect.unreachable('a delta resume is signed');
    registry.unsubscribe('s-alice-2', 'a2');

    // The later position's ids and sig, at the earlier lsn: the delete of p1 would replay.
    const alice = socketFor('s-alice-3', actor('alice'));
    const resumed = await registry.subscribe({
      socket: alice.socket,
      name: 'liveFeed',
      input,
      sid: 'a3',
      cursor: { ...cursor, ids: later.seated, sig },
    });
    expect(resumed.frame.type).toBe('snapshot');
    expect(registry.cursorsRefused).toBe(1);
  });

  test('a sig minted before the signing secret rotated', async () => {
    configureCursorSigning('secret-before-rotation-0123456789abcdef');
    const { registry } = world();
    const { cursor } = await aliceAway(registry);
    configureCursorSigning('secret-after-rotation-fedcba9876543210');

    await expectColdStart(registry, cursor);
  });

  test('a sig that is no sig at all', async () => {
    const { registry } = world();
    const { cursor } = await aliceAway(registry);
    await expectColdStart(registry, { ...cursor, ids: [...cursor.ids, 'p2'], sig: 'h1:0:0' });
  });
});

describe('a cursor with no sig', () => {
  test('takes the legacy path — a delta — and is counted', async () => {
    const { registry, unsigned } = world();
    const { cursor } = await aliceAway(registry);
    const { sig: _dropped, ...legacy } = cursor;
    await registry.deliver(change('insert', { ...P1, id: 'p4' }, 2));

    const { frame, seated } = await resumeAlice(registry, legacy);

    expect(frame.type).toBe('patch');
    expect([...seated]).toEqual(['p1', 'p5', 'p4']);
    expect(registry.unsignedCursors).toBe(1);
    expect(registry.cursorsRefused).toBe(0);
    expect(unsigned).toEqual([{ qid: cursor.qid, sid: 'a2', actorId: 'alice' }]);
  });

  test('a cursor for another window is a cold start before its sig is asked about', async () => {
    const { registry } = world();
    const { cursor } = await aliceAway(registry);
    const { frame } = await resumeAlice(registry, { ...cursor, qid: 'not-this-window' });
    expect(frame.type).toBe('snapshot');
    expect([registry.unsignedCursors, registry.cursorsRefused]).toEqual([0, 0]);
  });
});

describe('the client round trip', () => {
  test('a page echoes the sig of every frame it folded, and resumes from a delta', async () => {
    const { registry } = world();
    const { client, socket: page, clock: pageClock } = pageHarness();
    // The page stamps `at` off its own clock, and a cursor older than the lag budget re-snapshots.
    pageClock.advance(clock.now().getTime() - pageClock.now().getTime());
    page.open();
    const handle = client.subscribeLive(pageFeed, input);
    const sid = querySid(page, 'add');
    const server = socketFor('s-alice-1', actor('alice'));
    const bob = socketFor('s-bob', actor('bob'));
    await registry.subscribe({ socket: bob.socket, name: 'liveFeed', input, sid: 'b1' });

    // The node's own frames, off its wire and into the page: a snapshot, an insert, a withdraw
    // and an update — a new id set, a smaller one, and one that moves no id.
    const cold = await registry.subscribe({ socket: server.socket, name: 'liveFeed', input, sid });
    page.deliver(decode(JSON.stringify(cold.frame)));
    expect(handle.cursor()?.sig).toBe(cold.subscription.cursor.sig);
    await registry.deliver(change('insert', { ...P1, id: 'p4' }, 2));
    await registry.deliver(change('delete', SHARED, 3));
    await registry.deliver(change('update', { ...P1, title: 'edited' }, 4));
    expect(server.ws.frames.map((frame) => frame.type)).toEqual(['patch', 'patch', 'patch']);
    for (const frame of server.ws.frames) {
      page.deliver(frame);
      // The page never recomputes: what it holds is what the node seated, sig included.
      expect(handle.cursor()?.sig).toBe(frame.type === 'patch' ? frame.sig : undefined);
    }
    const held = handle.cursor();
    if (!held) return expect.unreachable('the page holds a cursor');
    const seated = registry.subscription(server.socket.id, sid)?.cursor;
    if (!seated) return expect.unreachable('the node still seats the subscription');
    expect({ ...held, at: 0 }).toEqual({ ...seated, at: 0 });

    // The socket drops; the page resumes on another with the cursor exactly as it would send it.
    registry.unsubscribe(server.socket.id, sid);
    await registry.deliver(change('insert', { ...P1, id: 'p7' }, 5));
    const echoed = decode(
      JSON.stringify({
        type: 'subscribe',
        v: cold.frame.v,
        op: 'add',
        sid,
        target: { kind: 'query', qid: 'liveFeed', input, cursor: held },
      }),
    );
    if (echoed.type !== 'subscribe' || echoed.target.kind !== 'query') {
      return expect.unreachable('a subscribe frame decodes as one');
    }
    const back = socketFor('s-alice-2', actor('alice'));
    const resumed = await registry.subscribe({
      socket: back.socket,
      name: 'liveFeed',
      input,
      sid,
      cursor: echoed.target.cursor,
    });

    expect(resumed.frame.type).toBe('patch');
    expect([registry.unsignedCursors, registry.cursorsRefused]).toEqual([0, 0]);
    page.deliver(decode(JSON.stringify(resumed.frame)));
    expect(handle.cursor()?.sig).toBe(resumed.subscription.cursor.sig);
    expect([...(handle.cursor()?.ids ?? [])]).toEqual(['p1', 'p4', 'p7']);
  });
});
