// Single responsibility: a transaction the SERVER rolled back is reported as one. Postgres answers
// `COMMIT` on an aborted transaction with the tag `ROLLBACK` and no error, so `withTransaction`
// resolved, `onCommit` fired and nothing was stored. Asked of the real embedded database, because a
// recording client aborts nothing; `transaction.live.test.ts` asks Postgres 17 the same questions.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createPgliteClient } from './pglite';
import { sql } from './sql';
import { withTransaction } from './transaction';

/** What a rejection is expected to be — read structurally, never cast to `any`. */
interface Caught {
  readonly code?: string | undefined;
  readonly cause?: string | undefined;
  readonly fix?: string | undefined;
}

const caught = (work: Promise<unknown>): Promise<Caught | undefined> =>
  work.then(
    () => undefined,
    (error: unknown) => error as Caught,
  );

describe('a transaction the server aborted', () => {
  const PGLITE_BOOT_MS = 30_000;
  const client = createPgliteClient();
  const ids = async (): Promise<readonly number[]> =>
    (await client.query<{ id: number }>(sql`select id from abort_rows order by id`)).map(
      (row) => row.id,
    );

  beforeEach(async () => {
    await client.execute(sql`drop table if exists abort_rows`);
    await client.execute(sql`create table abort_rows (id int primary key)`);
  }, PGLITE_BOOT_MS);

  afterAll(async () => {
    await client.close();
  });

  test('a body that swallows a failed statement rejects, and onCommit never fires', async () => {
    const fired: string[] = [];
    const error = await caught(
      withTransaction(
        async (tx) => {
          tx.onCommit(() => fired.push('commit'));
          tx.onRollback(() => fired.push('rollback'));
          await tx.execute(sql`insert into abort_rows values (1)`);
          // The unique-violation fallback: catch the refusal and carry on.
          await tx.execute(sql`insert into abort_rows values (1)`).catch(() => undefined);
        },
        { client },
      ),
    );

    expect(error?.code).toBe('X_DB_TRANSACTION_ABORTED');
    // The FIRST failing statement is the cause — the one the body threw away.
    expect(error?.cause).toContain('23505');
    expect(error?.fix).toContain('withTransaction');
    expect(fired).toEqual(['rollback']);
    expect(await ids()).toEqual([]);
  });

  test('the fallible statement in a nested scope leaves the outer one committable', async () => {
    await withTransaction(
      async (tx) => {
        await tx.execute(sql`insert into abort_rows values (1)`);
        await withTransaction(
          async (inner) => {
            await inner.execute(sql`insert into abort_rows values (1)`);
          },
          { client },
        ).catch(() => undefined);
        await tx.execute(sql`insert into abort_rows values (2)`);
      },
      { client },
    );
    expect(await ids()).toEqual([1, 2]);
  });

  test('a NESTED body that swallows a failed statement rejects, and only its own work is lost', async () => {
    let inner: Caught | undefined;
    await withTransaction(
      async (tx) => {
        await tx.execute(sql`insert into abort_rows values (1)`);
        inner = await caught(
          withTransaction(async (nested) => {
            await nested.execute(sql`insert into abort_rows values (2)`);
            await nested.execute(sql`insert into abort_rows values (1)`).catch(() => undefined);
          }),
        );
        await tx.execute(sql`insert into abort_rows values (3)`);
      },
      { client },
    );
    expect(inner?.code).toBe('X_DB_TRANSACTION_ABORTED');
    expect(await ids()).toEqual([1, 3]);
  });

  test('a nested scope opened on an aborted transaction is refused by name', async () => {
    const error = await caught(
      withTransaction(
        async (tx) => {
          await tx.execute(sql`insert into abort_rows values (1)`);
          await tx.execute(sql`insert into abort_rows values (1)`).catch(() => undefined);
          await withTransaction(async () => undefined);
        },
        { client },
      ),
    );
    expect(error?.code).toBe('X_DB_TRANSACTION_ABORTED');
    expect(error?.cause).toContain('23505');
  });

  test('two nested scopes under Promise.all nest one after the other, and both commit', async () => {
    const fired: number[] = [];
    await withTransaction(
      async (tx) => {
        await tx.execute(sql`insert into abort_rows values (1)`);
        await Promise.all(
          [2, 3].map((id) =>
            withTransaction(async (nested) => {
              nested.onCommit(() => fired.push(id));
              await nested.execute(sql`insert into abort_rows values (${id})`);
              // A second round trip, so the two bodies would interleave if nothing ordered them.
              await nested.query(sql`select 1`);
            }),
          ),
        );
      },
      { client },
    );
    expect(await ids()).toEqual([1, 2, 3]);
    expect(fired).toEqual([2, 3]);
  });

  test('one of two concurrent nested scopes failing takes only its own rows', async () => {
    await withTransaction(
      async (tx) => {
        await tx.execute(sql`insert into abort_rows values (1)`);
        const [first, second] = await Promise.allSettled([
          withTransaction(async (nested) => {
            await nested.execute(sql`insert into abort_rows values (2)`);
            await nested.query(sql`select 1`);
            throw new RangeError('the first scope failed');
          }),
          withTransaction(async (nested) => {
            await nested.execute(sql`insert into abort_rows values (3)`);
            await nested.query(sql`select 1`);
          }),
        ]);
        expect(first.status).toBe('rejected');
        expect(second.status).toBe('fulfilled');
      },
      { client },
    );
    expect(await ids()).toEqual([1, 3]);
  });

  // The session is one connection, so a statement sent on the CLIENT inside its own live
  // transaction joins it (`pglite.ts`'s `run`) without passing the scope's handle: only the
  // server's answer to COMMIT can say that statement aborted the unit of work.
  test('an abort the scope never saw is still caught by the COMMIT tag', async () => {
    const fired: string[] = [];
    const error = await caught(
      withTransaction(
        async (tx) => {
          tx.onCommit(() => fired.push('commit'));
          await tx.execute(sql`insert into abort_rows values (1)`);
          await client.execute(sql`insert into abort_rows values (1)`).catch(() => undefined);
        },
        { client },
      ),
    );
    expect(error?.code).toBe('X_DB_TRANSACTION_ABORTED');
    expect(fired).toEqual([]);
    expect(await ids()).toEqual([]);
  });
});
