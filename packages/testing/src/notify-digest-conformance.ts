// The `DigestStore` contract of `@ultimat3/notify` as checks: a rolling window one append opens and
// owns, a closed window sealed rather than lost, a drain that takes its own window and any older
// one a crashed flush left, and a replayed appender answered what it was answered the first time.
// Every check coalesces into a slot of its own, so one shared table serves them all.

import { expect } from 'bun:test';
import type { NotifyEvent } from '@ultimat3/notify';
import type { DigestSlot, DigestStore } from '@ultimat3/notify/adapter';

export interface DigestStoreCheck {
  readonly name: string;
  run(store: DigestStore): Promise<void>;
}

const WINDOW_MS = 100;

let minted = 0;
const slotOf = (): DigestSlot => {
  minted += 1;
  const recipient = `conformance-${process.pid.toString(36)}-${minted.toString(36)}`;
  return { recipient, notifier: 'post.commented', channel: 'email', group: 'g' };
};

const event = (key: string, at: number): NotifyEvent<unknown> => ({
  notifier: 'post.commented',
  key,
  params: { key },
  at: new Date(at),
});

const keys = (events: readonly NotifyEvent<unknown>[]): readonly string[] =>
  events.map((one) => one.key);

/** One run per event key unless named: a replay is the SAME appender again. */
const appendTo = (store: DigestStore, slot: DigestSlot) => (key: string, now: number) =>
  store.append({
    slot,
    event: event(key, now),
    windowMs: WINDOW_MS,
    now: new Date(now),
    appender: `run-${key}`,
  });

export const DIGEST_STORE_CHECKS: readonly DigestStoreCheck[] = [
  {
    name: 'the first append opens the window and a later one inside it joins',
    async run(store) {
      const slot = slotOf();
      const append = appendTo(store, slot);
      expect(await append('e1', 0)).toEqual({ opened: true, endsAt: 100 });
      expect(await append('e2', 50)).toEqual({ opened: false, endsAt: 100 });
      expect(keys(await store.drain(slot, 100))).toEqual(['e1', 'e2']);
      expect(await store.drain(slot, 100)).toEqual([]);
    },
  },
  {
    name: 'an append after a window closed opens a second and keeps the first',
    async run(store) {
      const slot = slotOf();
      const append = appendTo(store, slot);
      await append('e1', 0);
      expect(await append('e2', 150)).toEqual({ opened: true, endsAt: 250 });
      expect(keys(await store.drain(slot, 100))).toEqual(['e1']);
      expect(keys(await store.drain(slot, 250))).toEqual(['e2']);
    },
  },
  {
    name: 'the next window’s drain collects one a crashed flush left, oldest first',
    async run(store) {
      const slot = slotOf();
      const append = appendTo(store, slot);
      await append('e1', 0);
      await append('e2', 150);
      expect(keys(await store.drain(slot, 250))).toEqual(['e1', 'e2']);
    },
  },
  {
    name: 'a drain naming no window takes the oldest alone',
    async run(store) {
      const slot = slotOf();
      const append = appendTo(store, slot);
      await append('e1', 0);
      await append('e2', 150);
      expect(keys(await store.drain(slot))).toEqual(['e1']);
      expect(keys(await store.drain(slot))).toEqual(['e2']);
    },
  },
  {
    name: 'a window holds its events whole, `at` a Date, and slots never mix',
    async run(store) {
      const slot = slotOf();
      const other: DigestSlot = { ...slot, group: 'thread-2' };
      await appendTo(store, slot)('e1', 10);
      expect(await appendTo(store, other)('x1', 20)).toEqual({ opened: true, endsAt: 120 });
      expect(await store.drain(slot, 110)).toEqual([event('e1', 10)]);
      expect(keys(await store.drain(other, 120))).toEqual(['x1']);
    },
  },
  {
    name: 'a replayed append answers what the first one did and lands its event once',
    async run(store) {
      const slot = slotOf();
      const append = appendTo(store, slot);
      expect(await append('e1', 0)).toEqual({ opened: true, endsAt: 100 });
      expect(await append('e2', 10)).toEqual({ opened: false, endsAt: 100 });
      // The step that appended re-runs whole: both appenders arrive a second time.
      expect(await append('e1', 20)).toEqual({ opened: true, endsAt: 100 });
      expect(await append('e2', 30)).toEqual({ opened: false, endsAt: 100 });
      expect(keys(await store.drain(slot, 100))).toEqual(['e1', 'e2']);
    },
  },
  {
    name: 'a replay after its window closed answers that window, never a new one',
    async run(store) {
      const slot = slotOf();
      const append = appendTo(store, slot);
      await append('e1', 0);
      expect(await append('e2', 150)).toEqual({ opened: true, endsAt: 250 });
      expect(await append('e1', 160)).toEqual({ opened: true, endsAt: 100 });
      expect(keys(await store.drain(slot, 250))).toEqual(['e1', 'e2']);
    },
  },
  {
    name: 'a drained window forgets its appenders: the same run in a later window opens it',
    async run(store) {
      const slot = slotOf();
      const append = appendTo(store, slot);
      await append('e1', 0);
      await store.drain(slot, 100);
      expect(await append('e1', 150)).toEqual({ opened: true, endsAt: 250 });
    },
  },
];
