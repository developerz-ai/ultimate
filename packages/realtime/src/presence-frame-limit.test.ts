// Presence never emits a roster a client refuses: `readPresence` drops any list past
// `FRAME_LIMITS.members` whole, so a frame over it is a frame no subscriber ever reads.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { ChannelHub, type Topic, topic } from './channel';
import { readPresence } from './channel-presence';
import { InProcessTransport } from './fanout';
import type { JsonObject } from './json';
import { PRESENCE_KEY_PREFIX, PresenceRegistry } from './presence';
import { SocketRegistry } from './socket';
import { FRAME_LIMITS } from './sync-protocol';

const room = topic('org', 'o1', 'all-hands');

/** A hub that records what presence hands it, instead of fanning it out. */
class RecordingHub extends ChannelHub {
  readonly events: JsonObject[] = [];
  override async emit(_name: Topic, event: JsonObject): Promise<void> {
    this.events.push(event);
  }
}

function harness(maxMembers?: number) {
  const clock = frozenClock(0);
  const transport = new InProcessTransport({ clock });
  const hub = new RecordingHub({ transport, sockets: new SocketRegistry({ clock }) });
  const presence = new PresenceRegistry({
    transport,
    hub,
    clock,
    ttlMs: 30_000,
    ...(maxMembers === undefined ? {} : { maxMembers }),
  });
  /**
   * Members written straight into the shared set, then tracked by one sweep: `join` re-reads the
   * whole set per call, so seeding thousands through it is quadratic and minutes long.
   */
  async function seed(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const value = JSON.stringify({ actorId: null, meta: {}, updatedAt: 0 });
      const id = `m${String(i).padStart(5, '0')}`;
      await transport.shared.put(`${PRESENCE_KEY_PREFIX}.${room}`, id, value, 30_000);
    }
    await presence.sweep(room);
    hub.events.length = 0;
  }
  return { presence, hub, clock, seed };
}

describe('presence frames stay readable past the frame limit', () => {
  test('a sweep of more expired members than one frame holds leaves them in readable frames', async () => {
    const { presence, hub, clock, seed } = harness();
    const count = FRAME_LIMITS.members * 2 + 5;
    await seed(count);
    clock.advance(31_000);

    const gone = await presence.sweep(room);

    expect(gone).toHaveLength(count);
    const frames = hub.events.map(readPresence);
    // Every frame a client can read: none refused, so no subscriber keeps a stale roster.
    expect(frames.every((frame) => frame !== null)).toBe(true);
    expect(frames.map((frame) => frame?.presence)).toEqual(['leave', 'leave', 'leave']);
    const left = frames.flatMap((frame) => frame?.members.map((member) => member.id) ?? []);
    expect(new Set(left)).toEqual(new Set(gone.map((member) => member.id)));
    expect(left).toHaveLength(count);
  });

  test('a sweep under the limit is still one frame', async () => {
    const { presence, hub, clock } = harness();
    await presence.join(room, { id: 'm1', actorId: null });
    await presence.join(room, { id: 'm2', actorId: null });
    hub.events.length = 0;
    clock.advance(31_000);

    await presence.sweep(room);

    expect(hub.events.map((event) => readPresence(event)?.members.length)).toEqual([2]);
  });

  test('a maxMembers above the frame limit ships a full set a client can read', async () => {
    const { presence, seed } = harness(FRAME_LIMITS.members * 2);
    const count = FRAME_LIMITS.members + 10;
    await seed(count);

    const roster = await presence.roster(room);
    expect(roster.members).toHaveLength(FRAME_LIMITS.members);
    expect(roster.total).toBe(count);
    const frame = readPresence((await presence.syncFrame(room)).event);
    expect(frame?.members).toHaveLength(FRAME_LIMITS.members);
    expect(frame?.total).toBe(count);
  });
});
