// The cursor a refused event leaves, on BOTH buses: compared as `(publishedAt, id)`, never looked
// up. It was looked up, and a cursor whose event had been purged excluded nothing — so an event in
// the same millisecond, before the cursor, was handed to the wait again. Opt-in (`.job.`): the
// stored half boots Postgres.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { EmbeddedPg } from './embedded-pg-fixture';
import { embeddedPg } from './embedded-pg-fixture';
import type { EventBus } from './events';
import { memoryEventBus } from './events';
import { postgresEventBus } from './events-pg';

let pg: EmbeddedPg;

beforeEach(async () => {
  pg = await embeddedPg();
  await pg.reset();
});

afterAll(async () => {
  await (await embeddedPg()).close();
});

/** A frozen clock the memory bus reads, moved by hand: three publishes land in one millisecond. */
const clockAt = (start: number) => {
  let at = start;
  return {
    now: () => new Date(at),
    monotonic: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
};

interface Rig {
  readonly bus: EventBus;
  /** Remove one event the way its expiry would — the cursor's row is gone. */
  purge(id: string): Promise<void>;
}

const rigs: Record<'memory' | 'postgres', () => Rig> = {
  memory: () => {
    const clock = clockAt(1_000);
    const bus = memoryEventBus({ clock });
    return {
      bus,
      // The memory bus purges by expiry only, so the cursor's event is published to expire.
      purge: async () => {
        clock.advance(2);
        await bus.purgeExpired();
      },
    };
  },
  postgres: () => ({
    bus: postgresEventBus({ executor: pg.executor }),
    purge: async (id) => {
      await pg.executor.query('delete from x_job_events where id = $1', [id]);
    },
  }),
};

describe.each(['memory', 'postgres'] as const)('the cursor on the %s bus', (kind) => {
  test('a purged cursor still excludes the event before it in its millisecond', async () => {
    const { bus, purge } = rigs[kind]();
    const before = await bus.publish('paid', { n: 'before' }, { ttl: '1h' });
    const cursor = await bus.publish('paid', { n: 'cursor' }, { ttl: '1ms' });
    // One millisecond: the case the id tie-break exists for.
    expect(cursor.publishedAt).toBe(before.publishedAt);
    expect(cursor.id > before.id).toBe(true);

    const seen = await bus.find('paid', undefined, cursor.publishedAt, cursor.id);
    expect(seen).toBeUndefined();
    await purge(cursor.id);
    // Was `before` on both: the cursor's row gone, nothing was excluded.
    expect(await bus.find('paid', undefined, cursor.publishedAt, cursor.id)).toBeUndefined();
  });

  test('the next event past the cursor is still found, purged cursor or not', async () => {
    const { bus, purge } = rigs[kind]();
    const cursor = await bus.publish('paid', { n: 'cursor' }, { ttl: '1ms' });
    const after = await bus.publish('paid', { n: 'after' }, { ttl: '1h' });
    await purge(cursor.id);
    expect((await bus.find('paid', undefined, cursor.publishedAt, cursor.id))?.id).toBe(after.id);
  });

  test('without an id the cursor is "at or after afterMs", ties in id order', async () => {
    const { bus } = rigs[kind]();
    const first = await bus.publish('paid', { n: 1 });
    await bus.publish('paid', { n: 2 });
    expect((await bus.find('paid', undefined, first.publishedAt))?.id).toBe(first.id);
    expect(await bus.find('paid', undefined, first.publishedAt + 1)).toBeUndefined();
  });
});
