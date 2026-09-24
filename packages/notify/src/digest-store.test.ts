// Single responsibility: the memory digest store's windows. An append after a window CLOSED but
// before its flush drained it replaced the bucket, so the earlier window's events were never sent.

import { describe, expect, test } from 'bun:test';
import { createMemoryDigestStore, type DigestSlot } from './digest';
import type { NotifyEvent } from './notification';

const slot: DigestSlot = {
  recipient: 'ana',
  notifier: 'post.commented',
  channel: 'email',
  group: 'g',
};
const event = (id: string): NotifyEvent<unknown> =>
  ({ id, params: {}, at: new Date(0) }) as unknown as NotifyEvent<unknown>;
const ids = (events: readonly NotifyEvent<unknown>[]) =>
  events.map((one) => (one as unknown as { id: string }).id);

describe('memory digest store', () => {
  test('an append after a window closed opens a second window and keeps the first', async () => {
    const store = createMemoryDigestStore();
    const first = await store.append({ slot, event: event('e1'), windowMs: 100, now: new Date(0) });
    const second = await store.append({
      slot,
      event: event('e2'),
      windowMs: 100,
      now: new Date(150),
    });
    expect(first).toEqual({ opened: true, endsAt: 100 });
    expect(second).toEqual({ opened: true, endsAt: 250 });

    expect(ids(await store.drain(slot, first.endsAt))).toEqual(['e1']);
    expect(ids(await store.drain(slot, second.endsAt))).toEqual(['e2']);
    expect(store.open).toBe(0);
  });

  test('a flush whose owner crashed is collected by the next window’s drain', async () => {
    const store = createMemoryDigestStore();
    await store.append({ slot, event: event('e1'), windowMs: 100, now: new Date(0) });
    const second = await store.append({
      slot,
      event: event('e2'),
      windowMs: 100,
      now: new Date(150),
    });
    // Window one's flush never ran; window two's drain takes both, oldest first.
    expect(ids(await store.drain(slot, second.endsAt))).toEqual(['e1', 'e2']);
  });

  test('appends inside one window share it', async () => {
    const store = createMemoryDigestStore();
    const first = await store.append({ slot, event: event('e1'), windowMs: 100, now: new Date(0) });
    const again = await store.append({
      slot,
      event: event('e2'),
      windowMs: 100,
      now: new Date(50),
    });
    expect(again).toEqual({ opened: false, endsAt: first.endsAt });
    expect(ids(await store.drain(slot, first.endsAt))).toEqual(['e1', 'e2']);
  });
});
