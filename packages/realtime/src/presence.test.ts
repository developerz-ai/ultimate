import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { topic } from './channel';
import { InProcessTransport, type Transport } from './fanout';
import { PRESENCE_KEY_PREFIX, PRESENCE_SWEEP_PREFIX, PresenceRegistry } from './presence';

const room = topic('org', 'o1', 'cursors');

function harness(): { presence: PresenceRegistry; tick: (ms: number) => void } {
  const clock = frozenClock(0);
  const transport = new InProcessTransport({ clock });
  const presence = new PresenceRegistry({ transport, clock, ttlMs: 30_000 });
  return { presence, tick: (ms) => clock.advance(ms) };
}

describe('presence', () => {
  test('members join, are listed, and expire on TTL without anyone telling them to', async () => {
    const { presence, tick } = harness();
    await presence.join(room, { id: 'm1', actorId: 'alice', meta: { x: 1, y: 1 } });
    await presence.join(room, { id: 'm2', actorId: 'bob', meta: { x: 2, y: 2 } });

    expect((await presence.list(room)).map((member) => member.id)).toEqual(['m1', 'm2']);

    tick(10_000);
    expect(await presence.heartbeat(room, 'm1')).toBe(true);

    // m2 stopped beating — its node died, and no other node has to notice for it to expire.
    tick(25_000);
    expect((await presence.list(room)).map((member) => member.id)).toEqual(['m1']);
    expect(await presence.heartbeat(room, 'm2')).toBe(false);
  });

  test('metadata is last-write-wins per member: an out-of-order cursor is dropped', async () => {
    const { presence } = harness();
    await presence.join(room, { id: 'm1', actorId: 'alice', meta: { x: 1 }, updatedAt: 100 });

    await presence.update(room, { id: 'm1', actorId: 'alice', meta: { x: 9 }, updatedAt: 90 });
    expect((await presence.list(room))[0]?.meta).toEqual({ x: 1 });

    await presence.update(room, { id: 'm1', actorId: 'alice', meta: { x: 9 }, updatedAt: 110 });
    expect((await presence.list(room))[0]?.meta).toEqual({ x: 9 });
  });

  test('a sweep turns silent expiry into explicit leave events', async () => {
    const { presence, tick } = harness();
    await presence.join(room, { id: 'm1', actorId: 'alice' });
    tick(31_000);

    const gone = await presence.sweep(room);
    expect(gone.map((member) => member.id)).toEqual(['m1']);
    expect(await presence.sweep(room)).toHaveLength(0);
  });

  test('the sync frame carries the whole set — presence has no delta protocol', async () => {
    const { presence } = harness();
    await presence.join(room, { id: 'm1', actorId: 'alice' });
    const frame = await presence.syncFrame(room);
    if (frame.type !== 'presence') throw new Error('expected a presence frame');
    expect(frame.op).toBe('sync');
    expect(frame.members).toHaveLength(1);
    expect(frame.total).toBe(1);
  });
});

/**
 * A 5,000-person all-hands is the case that breaks presence: every join read the whole set and
 * shipped it, and every node re-read it for every room every ten seconds forever. Neither number
 * is one a UI or a bus should pay.
 */
describe('presence at all-hands size', () => {
  test('a full-set frame is capped, and says how many it is standing for', async () => {
    const clock = frozenClock(0);
    const transport = new InProcessTransport({ clock });
    const presence = new PresenceRegistry({ transport, clock, maxMembers: 3 });
    for (let i = 0; i < 12; i += 1) {
      await presence.join(room, { id: `m${String(i).padStart(2, '0')}`, actorId: `a${i}` });
    }

    const roster = await presence.roster(room);
    expect(roster.members).toHaveLength(3);
    expect(roster.total).toBe(12);
    // The set itself is never capped: the sweep differences it, so a short list would report
    // every member past the cap as gone.
    expect(await presence.list(room)).toHaveLength(12);

    const frame = await presence.syncFrame(room);
    if (frame.type !== 'presence') throw new Error('expected a presence frame');
    expect(frame.members).toHaveLength(3);
    expect(frame.total).toBe(12);
  });

  test('one node per topic sweeps, and the others read no member set at all', async () => {
    const clock = frozenClock(0);
    const transport = new InProcessTransport({ clock });
    const reads: string[] = [];
    const shared = transport.shared;
    const counting = {
      ...shared,
      entries: async (key: string) => {
        reads.push(key);
        return await shared.entries(key);
      },
      put: shared.put.bind(shared),
      touch: shared.touch.bind(shared),
      drop: shared.drop.bind(shared),
    };
    // Delegated member by member, NOT `{ ...transport, shared: counting }`: `transport` is a class
    // instance, so `publish`, `subscribe` and `close` live on its prototype and a spread copies
    // none of them — the wrapper that stood here was a `Transport` that could not fan out, and it
    // survived only because `PresenceRegistry` reads nothing but `shared`. The `shared` wrapper
    // above already re-binds every method by hand, for exactly this reason.
    const observed: Transport = {
      name: transport.name,
      shared: counting,
      publish: (subject, payload) => transport.publish(subject, payload),
      subscribe: (subject, handler) => transport.subscribe(subject, handler),
      close: () => transport.close(),
    };
    const fleet = ['node-a', 'node-b', 'node-c'].map(
      (nodeId) => new PresenceRegistry({ transport: observed, clock, nodeId }),
    );
    for (const node of fleet)
      await node.join(room, { id: `s-${node.constructor.name}`, actorId: null });
    reads.length = 0;

    for (const node of fleet) await node.sweepAll();

    // Three nodes, one room: one full-member-set read, not three. The rest is the lease.
    const memberReads = reads.filter(
      (key) => key.startsWith(`${PRESENCE_KEY_PREFIX}.`) && !key.startsWith(PRESENCE_SWEEP_PREFIX),
    );
    expect(memberReads).toHaveLength(1);
    expect(reads.filter((key) => key.startsWith(PRESENCE_SWEEP_PREFIX))).toHaveLength(3);
  });

  test('the leader is the same node every pass, so leaves are announced once', async () => {
    const clock = frozenClock(0);
    const transport = new InProcessTransport({ clock });
    const leader = new PresenceRegistry({ transport, clock, nodeId: 'node-a' });
    const follower = new PresenceRegistry({ transport, clock, nodeId: 'node-z' });
    await leader.join(room, { id: 'm1', actorId: 'alice' });
    await follower.join(room, { id: 'm2', actorId: 'bob' });
    // Both nodes see both members before either expires.
    await leader.sweepAll();
    await follower.sweepAll();

    clock.advance(31_000);
    const fromLeader = await leader.sweepAll();
    const fromFollower = await follower.sweepAll();

    expect(fromLeader.map((member) => member.id).sort()).toEqual(['m1', 'm2']);
    expect(fromFollower).toEqual([]);
  });
});

describe('the two numbers a client is told to beat by', () => {
  test('heartbeatMs is a third of the ttl, so one lost beat cannot read as a leave', () => {
    const transport = new InProcessTransport({ clock: frozenClock(0) });
    const presence = new PresenceRegistry({ transport, clock: frozenClock(0), ttlMs: 30_000 });
    expect(presence.ttlMs).toBe(30_000);
    expect(presence.heartbeatMs).toBe(10_000);
    // Two beats fit inside the ttl with room to spare — that is the whole point of the ratio.
    expect(presence.heartbeatMs * 2).toBeLessThan(presence.ttlMs);
  });

  test('the floor is one second: a tiny ttl must not turn into a beat-per-millisecond storm', () => {
    const transport = new InProcessTransport({ clock: frozenClock(0) });
    const tiny = new PresenceRegistry({ transport, clock: frozenClock(0), ttlMs: 300 });
    expect(tiny.ttlMs).toBe(300);
    expect(tiny.heartbeatMs).toBe(1_000);
  });

  test('the default ttl is used when the option is absent, and heartbeatMs follows it', () => {
    // No clock and no nodeId either: the defaults have to produce a usable registry, because a
    // single-node `x dev` constructs one with nothing but a transport.
    const presence = new PresenceRegistry({ transport: new InProcessTransport() });
    expect(presence.ttlMs).toBe(30_000);
    expect(presence.heartbeatMs).toBe(10_000);
  });
});
