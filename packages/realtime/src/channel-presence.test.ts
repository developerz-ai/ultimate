// Presence as a channel event: the payload a node emits and the one reader a client uses. A
// malformed roster is refused whole, never rendered in part.

import { describe, expect, test } from 'bun:test';
import { presenceEvent, readPresence } from './channel-presence';
import { FRAME_LIMITS } from './sync-protocol';

const member = { id: 'm1', actorId: 'alice', meta: { x: 10, y: 4 }, updatedAt: 12 };

describe('presence events', () => {
  test('a full set round-trips with its total; a delta carries none and invents none', () => {
    expect(readPresence(presenceEvent('sync', [member], 5_000))).toEqual({
      presence: 'sync',
      members: [member],
      total: 5_000,
    });
    const delta = readPresence(presenceEvent('join', [member]));
    expect(delta).toEqual({ presence: 'join', members: [member] });
    expect(delta !== null && 'total' in delta).toBe(false);
  });

  test('an app’s own event on the same channel is not presence', () => {
    expect(readPresence({ typing: true })).toBeNull();
    expect(readPresence({ presence: 'wave', members: [] })).toBeNull();
  });

  test('a non-numeric total, a bad member or an oversized roster is refused whole', () => {
    expect(readPresence({ ...presenceEvent('sync', [member]), total: 'lots' })).toBeNull();
    expect(readPresence({ presence: 'join', members: [{ id: 7 }] })).toBeNull();
    const many = Array.from({ length: FRAME_LIMITS.members + 1 }, (_, i) => ({
      ...member,
      id: `m${i}`,
    }));
    expect(readPresence({ presence: 'sync', members: many })).toBeNull();
  });
});
