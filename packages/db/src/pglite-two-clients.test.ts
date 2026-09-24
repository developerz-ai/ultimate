// Single responsibility: two embedded databases in one process, each with its own turn queue. A
// plain statement skips its client's queue only when the live transaction it runs inside is THAT
// client's — the fence read "is ANY transaction open", so an autocommit insert on A issued inside
// a transaction on B skipped A's queue, ran on A's single session while A's own transaction held
// it, and was rolled back with that transaction. Real PGlite on both sides: the fakes cannot tell
// one session's transaction from another's.

import { afterAll, describe, expect, test } from 'bun:test';
import { createPgliteClient } from './pglite';
import { sql } from './sql';
import { withTransaction } from './transaction';

const PGLITE_BOOT_MS = 60_000;

describe('two embedded clients', () => {
  const a = createPgliteClient();
  const b = createPgliteClient();

  afterAll(async () => {
    await a.close();
    await b.close();
  });

  test(
    "a transaction on B does not let A's autocommit write into A's own open transaction",
    async () => {
      await a.execute(sql`create table if not exists tc_posts (id int primary key)`);
      await b.execute(sql`select 1`);

      // INPUT, not a verdict: the body failing is what makes A's transaction roll back.
      const bodyFailure = new Error('A rolls back');
      const failing = withTransaction(
        async (tx) => {
          await tx.execute(sql`insert into tc_posts values (${1})`);
          await Bun.sleep(60);
          throw bodyFailure;
        },
        { client: a },
      );
      const acrossB = withTransaction(
        async () => {
          await Bun.sleep(15);
          // Autocommit on A, from inside B's live transaction: it must wait for A's turn.
          await a.execute(sql`insert into tc_posts values (${2})`);
        },
        { client: b },
      );

      await expect(failing).rejects.toThrow('A rolls back');
      await acrossB;
      expect(await a.query(sql`select id from tc_posts order by id`)).toEqual([{ id: 2 }]);
    },
    PGLITE_BOOT_MS,
  );
});
