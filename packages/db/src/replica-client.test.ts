// Single responsibility: which handle a statement lands on. The test that matters is
// read-your-writes — write a row, read it back in the same scope, and the read must be the
// primary's; a replica-routing layer that gets this wrong is a data-correctness bug worse than the
// capacity problem it was built to solve.

import { describe, expect, test } from 'bun:test';
import { type Clock, renderThrowable } from '@ultimat3/core';
import { db, isReservable, setDbClient } from './client';
import { createRecordingClient, type RecordingClient } from './fake';
import { reservableOver } from './fake-reservable';
import { replicatedClient } from './replica-client';
import { withReplicaReads } from './replica-scope';
import { sql } from './sql';
import { withTransaction } from './transaction';

interface Pair {
  readonly primary: RecordingClient;
  readonly replica: RecordingClient;
}

const pair = (): Pair => ({ primary: createRecordingClient(), replica: createRecordingClient() });

/** Monotonic time a test drives by hand; `now` is milliseconds since this fixture was made. */
function fakeClock(): Clock & { advance(ms: number): void } {
  let ms = 0;
  return {
    now: () => new Date(ms),
    monotonic: () => ms,
    advance(by: number): void {
      ms += by;
    },
  };
}

describe('read-your-writes', () => {
  test('a read after a write in the same scope is the primary`s, never the replica`s', async () => {
    const { primary, replica } = pair();
    const client = replicatedClient(primary, replica);

    await withReplicaReads(async () => {
      await client.execute(sql`insert into posts (id) values (${'p1'})`);
      await client.query(sql`select * from posts where id = ${'p1'}`);
    });

    expect(replica.texts).toEqual([]);
    expect(primary.texts.some((text) => text.startsWith('insert into posts'))).toBe(true);
    expect(primary.texts.some((text) => text.startsWith('select * from posts'))).toBe(true);
  });

  test('the write is seen across an await, at any depth — it is a scope, not a parameter', async () => {
    const { primary, replica } = pair();
    const client = replicatedClient(primary, replica);

    await withReplicaReads(async () => {
      // Three frames and two microtasks below the scope, which is where a repository's write is.
      const write = async (): Promise<void> => {
        await Promise.resolve();
        await client.execute(sql`update posts set likes = likes + 1`);
      };
      await write();
      await Promise.resolve();
      await client.query(sql`select likes from posts`);
    });

    expect(replica.texts).toEqual([]);
  });

  test('a nested scope does not un-write the scope that already wrote', async () => {
    const { primary, replica } = pair();
    const client = replicatedClient(primary, replica);

    await withReplicaReads(async () => {
      await client.execute(sql`insert into posts (id) values (${'p1'})`);
      await withReplicaReads(async () => {
        await client.query(sql`select * from posts`);
      });
    });

    expect(replica.texts).toEqual([]);
  });
});

describe('routing', () => {
  test('with no scope open nothing routes — a replica costs an unconfigured caller nothing', async () => {
    const { primary, replica } = pair();
    const client = replicatedClient(primary, replica);

    await client.query(sql`select 1`);

    expect(replica.texts).toEqual([]);
    expect(primary.texts).toEqual(['select 1']);
    expect(client.stats).toMatchObject({ replica: 0, primary: 1, fallbacks: 0 });
  });

  test('a plain read inside a clean scope is the replica`s', async () => {
    const { primary, replica } = pair();
    const client = replicatedClient(primary, replica);

    await withReplicaReads(() => client.query(sql`select id from posts where org_id = ${'o1'}`));

    expect(replica.texts).toEqual(['select id from posts where org_id = $1']);
    expect(primary.texts).toEqual([]);
    expect(client.stats).toMatchObject({ replica: 1, primary: 0 });
  });

  test('a CTE read routes, and a CTE that writes does not', async () => {
    const { primary, replica } = pair();
    const client = replicatedClient(primary, replica);

    await withReplicaReads(() => client.query(sql`with recent as (select 1) select * from recent`));
    await withReplicaReads(() =>
      client.query(sql`with done as (update posts set x = 1 returning *) select * from done`),
    );

    expect(replica.texts).toEqual(['with recent as (select 1) select * from recent']);
    expect(primary.texts).toHaveLength(1);
  });

  test('a reservation is always the primary`s, and only exists when the primary has one', async () => {
    const { primary, replica } = pair();
    const pinned = reservableOver(primary);
    const client = replicatedClient(pinned.client, replica);

    expect(isReservable(client)).toBe(true);
    if (!isReservable(client)) expect.unreachable('the wrapper dropped a reservable primary');
    using connection = await client.reserve();
    await connection.query(sql`select 1`);

    expect(pinned.pins.reserves).toBe(1);
    expect(replica.texts).toEqual([]);
    // A pooled primary that cannot pin must not gain the ability by being wrapped.
    expect(isReservable(replicatedClient(primary, replica))).toBe(false);
  });
});

describe('a replica that will not answer', () => {
  test('falls back to the primary with the same answer, and says so', async () => {
    const { primary, replica } = pair();
    primary.on('select id', { rows: [{ id: 'p1' }] });
    replica.on('select id', { rows: undefined });
    const failing: typeof replica = {
      ...replica,
      query: async () => {
        throw new TypeError('connection refused');
      },
    };
    const client = replicatedClient(primary, failing);

    const rows = await withReplicaReads(() => client.query<{ id: string }>(sql`select id from p`));

    expect(rows).toEqual([{ id: 'p1' }]);
    expect(client.stats.fallbacks).toBe(1);
    expect(client.stats.primary).toBe(1);
  });

  test('parks after three in a row, so an outage costs three doubled reads and not every read', async () => {
    const { primary, replica } = pair();
    let attempts = 0;
    const failing: typeof replica = {
      ...replica,
      query: async () => {
        attempts += 1;
        throw new TypeError('connection refused');
      },
    };
    const clock = fakeClock();
    const client = replicatedClient(primary, failing, { clock, breakerCooldownMs: 10_000 });

    for (let index = 0; index < 6; index += 1) {
      await withReplicaReads(() => client.query(sql`select 1`));
    }

    expect(attempts).toBe(3);
    expect(client.stats.parked).toBe(true);

    clock.advance(10_001);
    expect(client.stats.parked).toBe(false);
    await withReplicaReads(() => client.query(sql`select 1`));
    expect(attempts).toBe(4);
  });
});

describe('withTransaction over a replicated client', () => {
  test('every statement in it is the primary`s, and so is every read after it', async () => {
    const { primary, replica } = pair();
    const pinned = reservableOver(primary);
    const client = replicatedClient(pinned.client, replica);
    setDbClient(client);

    try {
      await withReplicaReads(async () => {
        await withTransaction(async (tx) => {
          await tx.query(sql`select id from posts`);
          await tx.execute(sql`insert into posts (id) values (${'p1'})`);
        });
        // The transaction committed; the request goes on. This read must NOT be a replica's.
        await db().query(sql`select id from posts`);
      });
    } finally {
      setDbClient(undefined);
    }

    expect(replica.texts).toEqual([]);
    expect(primary.texts).toContain('BEGIN');
    expect(primary.texts).toContain('COMMIT');
    expect(pinned.pins.reserves).toBe(1);
    expect(pinned.pins.releases).toBe(1);
  });

  test('a `readOnly: true` transaction leaves the scope clean, so later reads still route', async () => {
    const { primary, replica } = pair();
    const pinned = reservableOver(primary);
    const client = replicatedClient(pinned.client, replica);
    setDbClient(client);

    try {
      await withReplicaReads(async () => {
        await withTransaction(async (tx) => void (await tx.query(sql`select 1`)), {
          readOnly: true,
        });
        await db().query(sql`select id from posts`);
      });
    } finally {
      setDbClient(undefined);
    }

    expect(replica.texts).toEqual(['select id from posts']);
  });
});

/**
 * A circuit breaker is two comparisons and nothing else: `consecutiveFailures >= limit` opens it,
 * `clock.monotonic() < parkedUntil` holds it open. Both are false for every input when the number
 * behind them is `NaN` — so a breaker built from `Number(process.env.REPLICA_BREAKER_FAILURES)` on
 * an unset variable never opens, and every read keeps going to a replica that is failing.
 */
describe('the breaker numbers are screened where the client is built', () => {
  const buildWith = (options: Record<string, number>): string => {
    const { primary, replica } = pair();
    try {
      replicatedClient(primary, replica, options);
    } catch (error) {
      return renderThrowable(error);
    }
    return 'no-error-thrown';
  };

  test.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5])(
    'refuses breakerFailures %p, naming it',
    (breakerFailures) => {
      const rendered = buildWith({ breakerFailures });
      expect(rendered).toContain('X_INVARIANT');
      expect(rendered).toContain('breakerFailures');
    },
  );

  test.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5])(
    'refuses breakerCooldownMs %p, naming it',
    (breakerCooldownMs) => {
      const rendered = buildWith({ breakerCooldownMs });
      expect(rendered).toContain('X_INVARIANT');
      expect(rendered).toContain('breakerCooldownMs');
    },
  );

  test('real numbers still build a client', () => {
    const { primary, replica } = pair();
    expect(
      typeof replicatedClient(primary, replica, { breakerFailures: 3, breakerCooldownMs: 5_000 })
        .execute,
    ).toBe('function');
  });
});
