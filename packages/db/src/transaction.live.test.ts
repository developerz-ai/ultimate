// Single responsibility: `withTransaction(fn, { retry })` against a real serialization failure.
// A recording client can prove the loop counts; only Postgres can prove the thing it counts is a
// `40001` the framework recognised, which is the whole of D2 — `serializable` was unusable because
// nothing distinguished a lost race from a dead socket. Skips unless `TEST_DATABASE_URL` is set.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createPostgresClient, type PostgresClient } from './client';
import { raw, sql } from './sql';
import { withTransaction } from './transaction';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

/** What the loser is expected to be thrown — read structurally, never cast to `any`. */
interface CaughtError {
  readonly code?: string | undefined;
  readonly fix?: string | undefined;
}

/**
 * One half of a rendezvous: a promise and the call that settles it. Every ordering these tests
 * depend on is a gate, never a sleep and never wall-clock luck — see the choreography below.
 */
function gate(): { readonly reached: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { reached, open };
}

describe.skipIf(!hasPostgres)('live · postgres · serializable retry', () => {
  const clients: PostgresClient[] = [];

  const freshClient = (): PostgresClient => {
    const client = createPostgresClient({ url: url ?? '', role: 'web' });
    clients.push(client);
    return client;
  };

  beforeEach(async () => {
    const setup = freshClient();
    await setup.execute(raw('drop table if exists x_live_ledger'));
    await setup.execute(raw('create table x_live_ledger (id serial primary key, amount int)'));
    await setup.execute(raw('insert into x_live_ledger (amount) values (1), (1)'));
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  /**
   * The write skew SSI refuses, forced rather than raced. Both transactions read the whole table
   * — a seq scan over two rows, so a relation-level SIREAD predicate lock — and both then insert
   * into it, which is a rw-antidependency in each direction and the dangerous structure Postgres
   * aborts one side of.
   *
   * **Postgres only sees a conflict while the two overlap, so the order is gated end to end:**
   *
   * 1. the loser opens, reads, and opens `read`;
   * 2. only then does the winner open — so the loser's predicate lock is already held, and the
   *    winner's own read is taken against a transaction still in flight;
   * 3. the winner writes and commits (first committer wins, and only one edge exists at that
   *    moment, so the winner can never be the side that aborts), then opens `committed`;
   * 4. the loser writes, completing the pivot, and takes the `40001`.
   *
   * Nothing here is timing-dependent, and the version this replaced was nothing but. It started
   * both transactions at once and let the loser's `await` on the winner do the sequencing, which
   * gates step 4 and step 4 alone: the loser's *read* was left racing the winner's *whole*
   * transaction, and each side pays a cold pool connect first, because every test builds its
   * clients fresh. Measured against `pgvector/pgvector:pg17` — CI's own image — on a quiet laptop:
   * the winner committed 0.5ms after the loser's read landed. Lose that half-millisecond and the
   * loser reads a settled snapshot, commits on the first attempt, and both tests fail with "no
   * 40001 happened" — `attempts` 1 instead of 2, and nothing thrown to inspect. A backend fork is
   * tens of milliseconds and jitters with load, which is why a busy CI runner lands the other side
   * of it. Reproduced deterministically by delaying the loser's read past the winner's commit.
   *
   * A retry runs alone — the winner is long gone — so attempt 2 skips both gates and commits.
   */
  const loseTheSerializationRace = async (
    retry: number,
  ): Promise<{ readonly attempts: number; readonly caught: CaughtError | undefined }> => {
    const read = gate();
    const committed = gate();
    let attempts = 0;

    const loser = withTransaction(
      async (tx) => {
        attempts += 1;
        await tx.query(sql`select sum(amount) from x_live_ledger`);
        if (attempts === 1) {
          read.open();
          await committed.reached;
        }
        await tx.execute(sql`insert into x_live_ledger (amount) values (10)`);
      },
      { isolation: 'serializable', retry, client: freshClient() },
    ).then(
      () => undefined,
      (error: unknown) => error as CaughtError,
    );

    // Raced against the loser itself, not awaited bare: a loser that fails *before* its read never
    // opens the gate, and a bare await would hang until the test timeout, reporting a 20s stall
    // instead of the connection error that caused it.
    await Promise.race([read.reached, loser]);

    await withTransaction(
      async (tx) => {
        await tx.query(sql`select sum(amount) from x_live_ledger`);
        await tx.execute(sql`insert into x_live_ledger (amount) values (20)`);
      },
      { isolation: 'serializable', client: freshClient() },
    );
    committed.open();

    const caught = await loser;
    return { attempts, caught };
  };

  test('a real 40001 is retried, and the second attempt commits', async () => {
    const { attempts, caught } = await loseTheSerializationRace(3);

    // Exactly two, not "at least two": the choreography forces one conflict, so a third attempt
    // would mean the retry re-ran a body that had nothing left to lose to.
    expect(attempts).toBe(2);
    expect(caught).toBeUndefined();
    const rows = await freshClient().query<{ amount: number }>(
      sql`select amount from x_live_ledger order by amount`,
    );
    // Both writes landed exactly once: the retry re-ran the body, it did not duplicate it.
    expect(rows.map((row) => row.amount)).toEqual([1, 1, 10, 20]);
  }, 20_000);

  test('retry: 0 surfaces the 40001 as X_DB_SERIALIZATION_FAILURE, never as unreachable', async () => {
    const { attempts, caught } = await loseTheSerializationRace(0);

    expect(attempts).toBe(1);
    expect(caught?.code).toBe('X_DB_SERIALIZATION_FAILURE');
    expect(caught?.fix).toContain('withTransaction(fn, { retry: 3 })');
    // The loser's row is gone with its transaction; the winner's is durable.
    const rows = await freshClient().query<{ amount: number }>(
      sql`select amount from x_live_ledger order by amount`,
    );
    expect(rows.map((row) => row.amount)).toEqual([1, 1, 20]);
  }, 20_000);
});
