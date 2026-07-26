import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { topic } from './channel';
import { InProcessTransport } from './fanout';
import { PresenceRegistry } from './presence';

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
  });
});
