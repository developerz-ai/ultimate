// The per-topic ring: seq minted by one, and a `since` answered from it only when every entry
// after that position is still held — anything else is `null`, which the hub turns into
// `replay-gap`.

import { describe, expect, test } from 'bun:test';
import { ChannelRing } from './channel-ring';

const part = (key: string) => ({ type: 'posts', key, row: { id: key } });

describe('ChannelRing', () => {
  test('seq counts up by one per entry, starting at 1', () => {
    const ring = new ChannelRing('e1');
    expect(ring.seq).toBe(0);
    expect(ring.append([part('a')], []).seq).toBe(1);
    expect(ring.append([], [{ type: 'posts', key: 'a' }]).seq).toBe(2);
    expect(ring.seq).toBe(2);
  });

  test('since a held position answers exactly the entries after it', () => {
    const ring = new ChannelRing('e1', 4);
    for (const key of ['a', 'b', 'c']) ring.append([part(key)], []);
    expect(ring.since({ epoch: 'e1', seq: 1 })?.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(ring.since({ epoch: 'e1', seq: 3 })).toEqual([]);
    expect(ring.since({ epoch: 'e1', seq: 0 })?.map((entry) => entry.seq)).toEqual([1, 2, 3]);
  });

  test('a position the ring no longer holds all of is null, never a partial replay', () => {
    const ring = new ChannelRing('e1', 2);
    for (const key of ['a', 'b', 'c', 'd']) ring.append([part(key)], []);
    // Held: 3 and 4. Since 2 needs only those; since 1 needs 2, which is gone.
    expect(ring.since({ epoch: 'e1', seq: 2 })?.map((entry) => entry.seq)).toEqual([3, 4]);
    expect(ring.since({ epoch: 'e1', seq: 1 })).toBeNull();
  });

  test('another epoch, a future seq and a negative one are all null', () => {
    const ring = new ChannelRing('e1');
    ring.append([part('a')], []);
    expect(ring.since({ epoch: 'e0', seq: 1 })).toBeNull();
    expect(ring.since({ epoch: 'e1', seq: 9 })).toBeNull();
    expect(ring.since({ epoch: 'e1', seq: -1 })).toBeNull();
  });

  test('a non-finite capacity is refused where the ring is built', () => {
    expect(() => new ChannelRing('e1', Number.NaN)).toThrow(
      expect.objectContaining({ code: 'X_INVARIANT' }),
    );
  });
});
