// A statement on a `DbTx` whose scope already ended is refused. A dead handle used to fall through
// `held` to the pool, so the loser of a `Promise.all` wrote a row for a unit of work that had rolled
// back — autocommitted, on Postgres and PGlite alike. `db()` answers that dead handle, so every
// repository took this path. `transaction-closed.live.test.ts` asks Postgres the same questions.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { db, setDbClient } from './client';
import { pgliteClient } from './pglite';
import { type SqlFragment, sql } from './sql';
import { type currentTx, outsideTransaction, withTransaction } from './transaction';

// A foreign failure handed to the subject: test input, never its verdict.
const BODY_FAILED = new RangeError('the body failed');
const ROOT_FAILED = new RangeError('the root failed');

const PGLITE_BOOT_MS = 30_000;
const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code;

describe('a straggler on a finished transaction', () => {
  const client = pgliteClient();
  const count = async (): Promise<number> => {
    const rows = await client.query<{ total: number }>(
      sql`select count(*)::int as total from closed_rows`,
    );
    return rows[0]?.total ?? -1;
  };

  beforeEach(async () => {
    setDbClient(client);
    await client.execute(sql`drop table if exists closed_rows`);
    await client.execute(sql`create table closed_rows (id int primary key)`);
  }, PGLITE_BOOT_MS);

  afterAll(async () => {
    setDbClient(undefined);
    await client.close();
  });

  /** The sibling that outlives its transaction: writes through `db()` once the scope is over. */
  const straggler = (): {
    readonly settled: Promise<unknown>;
    run(): Promise<unknown>;
    scopeEnded(): void;
  } => {
    const ended = Promise.withResolvers<void>();
    let settled: Promise<unknown> = Promise.resolve();
    return {
      get settled() {
        return settled;
      },
      scopeEnded: () => ended.resolve(),
      run: () => {
        settled = ended.promise.then(() => db().execute(sql`insert into closed_rows values (1)`));
        // Observed here so the test reads the outcome; the app's `Promise.all` holds it the same way.
        settled.catch(() => undefined);
        return settled;
      },
    };
  };

  test('after a rollback it is refused and leaves 0 rows', async () => {
    const late = straggler();
    await withTransaction(
      () => Promise.all([late.run(), Promise.reject(new RangeError('the sibling failed'))]),
      { client },
    ).catch(() => undefined);
    late.scopeEnded();

    const error = await late.settled.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(codeOf(error)).toBe('X_DB_TRANSACTION_CLOSED');
    expect(await count()).toBe(0);
  });

  test('after a commit it is refused too: it missed the COMMIT, so it was never in the unit of work', async () => {
    const late = straggler();
    await withTransaction(
      async () => {
        void late.run();
      },
      { client },
    );
    late.scopeEnded();

    const error = await late.settled.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(codeOf(error)).toBe('X_DB_TRANSACTION_CLOSED');
    expect(await count()).toBe(0);
  });

  test('a statement sent while the ROLLBACK is in flight is refused, never autocommitted', async () => {
    let handle: ReturnType<typeof currentTx>;
    let late: Promise<unknown> = Promise.resolve();
    const failing = withTransaction(
      async (tx) => {
        handle = tx;
        // The body's own failure runs the `catch`, which awaits ROLLBACK; this continuation runs
        // straight after, inside that window.
        queueMicrotask(() => {
          queueMicrotask(() => {
            late = (handle as NonNullable<typeof handle>).execute(
              sql`insert into closed_rows values (2)`,
            );
            late.catch(() => undefined);
          });
        });
        throw BODY_FAILED;
      },
      { client },
    ).catch(() => undefined);
    await failing;
    const error = await late.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(codeOf(error)).toBe('X_DB_TRANSACTION_CLOSED');
    expect(await count()).toBe(0);
  });

  test('a statement sent while the COMMIT is in flight is refused, never run after it', async () => {
    // The answer to COMMIT is held, so the statement goes out in exactly that window: on the wire it
    // would follow the COMMIT on this connection, outside any transaction, and land.
    let answer = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    let sentCommit = (): void => undefined;
    const commitSent = new Promise<void>((resolve) => {
      sentCommit = resolve;
    });
    const reserve = client.reserve.bind(client);
    const holdingCommit = new Proxy(client, {
      get(target, member, receiver) {
        if (member !== 'reserve') return Reflect.get(target, member, receiver);
        return async () => {
          const pin = await reserve();
          return new Proxy(pin, {
            get(inner, name) {
              const value = Reflect.get(inner, name);
              if (name !== 'execute') {
                return typeof value === 'function' ? value.bind(inner) : value;
              }
              return async (fragment: SqlFragment) => {
                if (fragment.text !== 'COMMIT') return inner.execute(fragment);
                sentCommit();
                await held;
                return inner.execute(fragment);
              };
            },
          });
        };
      },
    });
    let handle: ReturnType<typeof currentTx>;
    const done = withTransaction(
      async (tx) => {
        handle = tx;
      },
      { client: holdingCommit },
    );
    await commitSent;
    const error = await (handle as NonNullable<typeof handle>)
      .execute(sql`insert into closed_rows values (7)`)
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    answer();
    await done;
    expect(codeOf(error)).toBe('X_DB_TRANSACTION_CLOSED');
    expect(await count()).toBe(0);
  });

  test('a sibling queued when the root rolled back is told CLOSED, and the dead pin hears nothing', async () => {
    const sent: string[] = [];
    const reserve = client.reserve.bind(client);
    const recording = new Proxy(client, {
      get(target, member, receiver) {
        if (member !== 'reserve') return Reflect.get(target, member, receiver);
        return async () => {
          const pin = await reserve();
          return new Proxy(pin, {
            get(inner, name) {
              const value = Reflect.get(inner, name);
              if (name !== 'execute') {
                return typeof value === 'function' ? value.bind(inner) : value;
              }
              return (fragment: SqlFragment) => {
                sent.push(fragment.text);
                return inner.execute(fragment);
              };
            },
          });
        };
      },
    });
    const entered = Promise.withResolvers<void>();
    const rootEnded = Promise.withResolvers<void>();
    let holder: Promise<unknown> = Promise.resolve();
    let queued: Promise<unknown> = Promise.resolve();
    await withTransaction(
      async () => {
        holder = withTransaction(async () => {
          entered.resolve();
          await rootEnded.promise;
        });
        queued = withTransaction((tx) => tx.execute(sql`insert into closed_rows values (8)`));
        holder.catch(() => undefined);
        queued.catch(() => undefined);
        // The holder has its savepoint before the root gives up.
        await entered.promise;
        throw ROOT_FAILED;
      },
      { client: recording },
    ).catch(() => undefined);
    rootEnded.resolve();

    expect(codeOf(await holder.catch((thrown: unknown) => thrown))).toBe('X_DB_TRANSACTION_CLOSED');
    expect(codeOf(await queued.catch((thrown: unknown) => thrown))).toBe('X_DB_TRANSACTION_CLOSED');
    expect(sent.slice(sent.indexOf('ROLLBACK') + 1)).toEqual([]);
    expect(await count()).toBe(0);
  });

  test('the refusal rejects rather than throwing, and its fix is the instruction', async () => {
    let handle: ReturnType<typeof currentTx>;
    await withTransaction(
      async (tx) => {
        handle = tx;
      },
      { client },
    );
    const sent = (handle as NonNullable<typeof handle>).query(sql`select 1`);
    const error = (await sent.catch((thrown: unknown) => thrown)) as {
      fix?: string;
      cause?: string;
    };
    expect(codeOf(error)).toBe('X_DB_TRANSACTION_CLOSED');
    expect(error.fix).toContain('outsideTransaction');
    expect(error.cause).toContain('committed');
  });

  test('a nested withTransaction from a straggler is refused by name, not by 25P01', async () => {
    const ended = Promise.withResolvers<void>();
    let late: Promise<unknown> = Promise.resolve();
    await withTransaction(
      async () => {
        late = ended.promise.then(() =>
          withTransaction((tx) => tx.execute(sql`insert into closed_rows values (3)`)),
        );
        late.catch(() => undefined);
      },
      { client },
    );
    ended.resolve();
    const error = await late.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(codeOf(error)).toBe('X_DB_TRANSACTION_CLOSED');
    expect(await count()).toBe(0);
  });

  test('outsideTransaction is the door: the straggler autocommits on the pool, as asked', async () => {
    const ended = Promise.withResolvers<void>();
    let late: Promise<unknown> = Promise.resolve();
    await withTransaction(
      async () => {
        late = ended.promise.then(() =>
          outsideTransaction(() => db().execute(sql`insert into closed_rows values (4)`)),
        );
      },
      { client },
    );
    ended.resolve();
    await late;
    expect(await count()).toBe(1);
  });

  test('onCommit effects keep working: one registered late runs off the dead store', async () => {
    const seen: number[] = [];
    let late: Promise<unknown> = Promise.resolve();
    await withTransaction(
      async (tx) => {
        tx.onCommit(() => {
          // The ordinary path: runs outside the scope, so `db()` is the pool.
          late = db().execute(sql`insert into closed_rows values (5)`);
          seen.push(1);
        });
      },
      { client },
    );
    await late;
    expect(seen).toEqual([1]);
    expect(await count()).toBe(1);

    let handle: ReturnType<typeof currentTx>;
    const ended = Promise.withResolvers<void>();
    let stragglerDone: Promise<unknown> = Promise.resolve();
    await withTransaction(
      async (tx) => {
        handle = tx;
        stragglerDone = ended.promise.then(() => {
          // After the COMMIT, on the straggler's own async path: the effect fires at once, and it
          // must not inherit the dead handle.
          let inner: Promise<unknown> = Promise.resolve();
          (handle as NonNullable<typeof handle>).onCommit(() => {
            inner = db().execute(sql`insert into closed_rows values (6)`);
            seen.push(2);
          });
          return inner;
        });
      },
      { client },
    );
    ended.resolve();
    await stragglerDone;
    expect(seen).toEqual([1, 2]);
    expect(await count()).toBe(2);
  });
});
