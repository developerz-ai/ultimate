import { beforeEach, describe, expect, test } from 'bun:test';
import { type DbClient, setDbClient } from './client';
import { type DbError, dbUnavailable, driverError } from './errors';
import { createRecordingClient, type RecordingClient } from './fake';
import { reservableOver } from './fake-reservable';
import { sql } from './sql';
import { beginStatement, currentTx, withTransaction } from './transaction';

let client: RecordingClient;

beforeEach(() => {
  client = createRecordingClient();
  setDbClient(client);
});

describe('withTransaction', () => {
  test('currentTx() is visible inside and undefined outside', async () => {
    expect(currentTx()).toBeUndefined();

    const seen = await withTransaction(async (tx) => {
      expect(currentTx()).toBe(tx);
      expect(tx.id).toMatch(/^tx_/);
      await tx.query(sql`select 1`);
      return tx.id;
    });

    expect(seen).toMatch(/^tx_/);
    expect(currentTx()).toBeUndefined();
    expect(client.texts).toEqual(['BEGIN', 'select 1', 'COMMIT']);
  });

  test('an ambient tx survives an await boundary, which is what the outbox relies on', async () => {
    await withTransaction(async (tx) => {
      await Promise.resolve();
      expect(currentTx()?.id).toBe(tx.id);
    });
  });

  test('a nested call emits a SAVEPOINT and releases it on success', async () => {
    await withTransaction(async () => {
      await withTransaction(async (inner) => {
        expect(currentTx()).toBe(inner);
        await inner.execute(sql`update posts set likes = likes + 1`);
      });
    });

    expect(client.texts).toEqual([
      'BEGIN',
      'SAVEPOINT x_sp_1',
      'update posts set likes = likes + 1',
      'RELEASE SAVEPOINT x_sp_1',
      'COMMIT',
    ]);
  });

  test('a nested throw rolls back to the savepoint and leaves the outer alive', async () => {
    const undone: string[] = [];

    await withTransaction(async (outer) => {
      outer.onRollback(() => undone.push('outer'));
      await expect(
        withTransaction(async (inner) => {
          inner.onRollback(() => undone.push('inner'));
          throw new Error('nope');
        }),
      ).rejects.toThrow('nope');
      await outer.execute(sql`select 2`);
    });

    expect(client.texts).toEqual([
      'BEGIN',
      'SAVEPOINT x_sp_1',
      'ROLLBACK TO SAVEPOINT x_sp_1',
      'select 2',
      'COMMIT',
    ]);
    expect(undone).toEqual(['inner']);
  });

  test('a throw rolls back and fires onRollback hooks in reverse order', async () => {
    const undone: string[] = [];

    await expect(
      withTransaction(async (tx) => {
        tx.onRollback(() => undone.push('first'));
        tx.onRollback(() => undone.push('second'));
        await tx.execute(sql`insert into posts (id) values (${'p1'})`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(client.texts).toEqual(['BEGIN', 'insert into posts (id) values ($1)', 'ROLLBACK']);
    expect(undone).toEqual(['second', 'first']);
    expect(currentTx()).toBeUndefined();
  });

  test('a hook that throws does not mask the original failure', async () => {
    await expect(
      withTransaction(async (tx) => {
        tx.onRollback(() => {
          throw new Error('undo failed');
        });
        throw new Error('original');
      }),
    ).rejects.toThrow('original');
  });

  test('nested hooks are promoted so an outer rollback still undoes them', async () => {
    const undone: string[] = [];

    await expect(
      withTransaction(async (outer) => {
        await withTransaction(async (inner) => {
          inner.onRollback(() => undone.push('inner'));
        });
        outer.onRollback(() => undone.push('outer'));
        throw new Error('late');
      }),
    ).rejects.toThrow('late');

    expect(undone).toEqual(['outer', 'inner']);
  });

  test('isolation, readOnly and deferrable are explicit in the BEGIN', () => {
    expect(beginStatement({})).toBe('BEGIN');
    expect(beginStatement({ isolation: 'read committed' })).toBe(
      'BEGIN ISOLATION LEVEL READ COMMITTED',
    );
    expect(beginStatement({ isolation: 'serializable', readOnly: true, deferrable: true })).toBe(
      'BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE',
    );
  });

  test('the isolation level reaches the wire', async () => {
    await withTransaction(async () => undefined, { isolation: 'repeatable read' });
    expect(client.texts[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ');
  });
});

describe('withTransaction and the reserved connection', () => {
  test('a reservable client is pinned once and released once', async () => {
    const { client: reservable, pins } = reservableOver(client);

    await withTransaction(
      async (tx) => {
        await tx.execute(sql`select 1`);
      },
      { client: reservable },
    );

    expect(pins).toEqual({ reserves: 1, releases: 1 });
    expect(client.texts).toEqual(['BEGIN', 'select 1', 'COMMIT']);
  });

  test('a rejecting BEGIN gives the pin back instead of leaking it', async () => {
    const texts: string[] = [];
    const boom = dbUnavailable('statement failed: BEGIN');
    const dead: DbClient = {
      query: async () => [],
      one: async () => null,
      // Every statement fails, the rollback included — a connection that could not BEGIN is
      // exactly the one that cannot ROLLBACK either.
      execute: async (fragment) => {
        texts.push(fragment.text);
        throw boom;
      },
    };
    const { client: reservable, pins } = reservableOver(dead);
    let bodyRan = false;

    await expect(
      withTransaction(
        async () => {
          bodyRan = true;
        },
        { client: reservable },
      ),
    ).rejects.toBe(boom);

    expect(bodyRan).toBe(false);
    expect(texts).toEqual(['BEGIN', 'ROLLBACK']);
    expect(pins).toEqual({ reserves: 1, releases: 1 });
    expect(currentTx()).toBeUndefined();
  });

  test('a rejecting COMMIT gives the pin back and reports the commit failure', async () => {
    const boom = dbUnavailable('statement failed: COMMIT');
    const failsOnCommit: DbClient = {
      query: async () => [],
      one: async () => null,
      execute: async (fragment) => {
        if (fragment.text === 'COMMIT') throw boom;
        return 0;
      },
    };
    const { client: reservable, pins } = reservableOver(failsOnCommit);
    const undone: string[] = [];

    await expect(
      withTransaction(
        async (tx) => {
          tx.onRollback(() => undone.push('undo'));
        },
        { client: reservable },
      ),
    ).rejects.toBe(boom);

    expect(undone).toEqual(['undo']);
    expect(pins).toEqual({ reserves: 1, releases: 1 });
  });

  test('a client that cannot be reserved runs on the pool, unpinned', async () => {
    await withTransaction(
      async (tx) => {
        await tx.execute(sql`select 1`);
      },
      { client },
    );

    expect(client.texts).toEqual(['BEGIN', 'select 1', 'COMMIT']);
  });

  // A nested `withTransaction` reuses `outer.connection` (`runNested`, transaction.ts:80) rather
  // than reserving again — that sharing is what makes SAVEPOINT/RELEASE land on the same physical
  // connection BEGIN did. A second `reserve()` per level would pin a second connection per
  // SAVEPOINT, and the root's `using` would only ever give one of them back: a leak per nesting
  // depth, invisible to every test above because none of them nest three deep under a pin.
  test('nesting three deep still takes and releases exactly one pin', async () => {
    const { client: reservable, pins } = reservableOver(client);
    const undone: string[] = [];

    await expect(
      withTransaction(
        async (outer) => {
          outer.onRollback(() => undone.push('outer'));
          await withTransaction(async (inner) => {
            inner.onRollback(() => undone.push('inner'));
            await withTransaction(async (innermost) => {
              innermost.onRollback(() => undone.push('innermost'));
              throw new Error('deep failure');
            });
          });
        },
        { client: reservable },
      ),
    ).rejects.toThrow('deep failure');

    expect(pins).toEqual({ reserves: 1, releases: 1 });
    expect(undone).toEqual(['innermost', 'inner', 'outer']);
  });
});

describe('withTransaction rollback failures', () => {
  test('a failing ROLLBACK TO SAVEPOINT does not mask the error that caused it', async () => {
    const texts: string[] = [];
    const undone: string[] = [];
    const savepointRollbackFails: DbClient = {
      query: async () => [],
      one: async () => null,
      execute: async (fragment) => {
        texts.push(fragment.text);
        if (fragment.text.startsWith('ROLLBACK TO SAVEPOINT')) {
          throw dbUnavailable('statement failed: ROLLBACK TO SAVEPOINT x_sp_1');
        }
        return 0;
      },
    };

    await expect(
      withTransaction(
        async () => {
          await withTransaction(async (inner) => {
            inner.onRollback(() => undone.push('inner'));
            throw new Error('inner failed');
          });
        },
        { client: savepointRollbackFails },
      ),
    ).rejects.toThrow('inner failed');

    expect(texts).toEqual([
      'BEGIN',
      'SAVEPOINT x_sp_1',
      'ROLLBACK TO SAVEPOINT x_sp_1',
      'ROLLBACK',
    ]);
    expect(undone).toEqual(['inner']);
  });

  test('a failing SAVEPOINT reaches the caller and aborts the outer transaction', async () => {
    const texts: string[] = [];
    const boom = dbUnavailable('statement failed: SAVEPOINT x_sp_1');
    const savepointFails: DbClient = {
      query: async () => [],
      one: async () => null,
      execute: async (fragment) => {
        texts.push(fragment.text);
        if (fragment.text.startsWith('SAVEPOINT')) throw boom;
        return 0;
      },
    };
    let innerRan = false;

    await expect(
      withTransaction(
        async () => {
          await withTransaction(async () => {
            innerRan = true;
          });
        },
        { client: savepointFails },
      ),
    ).rejects.toBe(boom);

    expect(innerRan).toBe(false);
    expect(texts).toEqual(['BEGIN', 'SAVEPOINT x_sp_1', 'ROLLBACK']);
  });
});

describe('retry', () => {
  /** A driver failure as the funnel produces one: typed, with the server's SQLSTATE underneath. */
  const serialization = (): unknown =>
    driverError(
      'statement failed: update ledger',
      Object.assign(new Error('could not serialize access'), {
        code: 'ERR_POSTGRES_SERVER_ERROR',
        errno: '40001',
      }),
    );

  test('no retry by default, so adding the option changed nothing that already shipped', async () => {
    let attempts = 0;

    const caught = (await withTransaction(async () => {
      attempts += 1;
      throw serialization();
    }).catch((error: unknown) => error)) as DbError;

    expect(attempts).toBe(1);
    expect(caught.code).toBe('X_DB_SERIALIZATION_FAILURE');
    // The driver's own error, unwrapped: nothing was exhausted, so the instruction is "add a
    // budget", never "raise the one you have".
    expect(caught.fix).toContain('withTransaction(fn, { retry: 3 })');
    expect(caught.cause).not.toContain('attempts');
  });

  test('a lost serialization race re-runs fn from the top and can succeed', async () => {
    // Under SERIALIZABLE a 40001 is normal traffic: at 200 tps ~3% of transactions hit one, and
    // before this every one of them surfaced to the user as "cannot reach the database".
    let attempts = 0;

    const result = await withTransaction(
      async () => {
        attempts += 1;
        if (attempts < 3) throw serialization();
        return 'committed';
      },
      { retry: 3, isolation: 'serializable' },
    );

    expect(result).toBe('committed');
    expect(attempts).toBe(3);
    expect(client.texts.filter((text) => text.startsWith('BEGIN'))).toHaveLength(3);
    expect(client.texts.filter((text) => text === 'ROLLBACK')).toHaveLength(2);
    expect(client.texts.filter((text) => text === 'COMMIT')).toHaveLength(1);
  });

  test('the undos of a failed attempt fire before the next one starts', async () => {
    const order: string[] = [];
    let attempts = 0;

    await withTransaction(
      async (tx) => {
        attempts += 1;
        order.push(`attempt ${attempts}`);
        tx.onRollback(() => order.push(`undo ${attempts}`));
        if (attempts === 1) throw serialization();
      },
      { retry: 1 },
    );

    // An undo that ran after the retry had already started would be reverting the retry's work.
    expect(order).toEqual(['attempt 1', 'undo 1', 'attempt 2']);
  });

  test('anything that is not a serialization failure is thrown on the first attempt', async () => {
    let attempts = 0;
    const unique = driverError(
      'statement failed: insert into users',
      Object.assign(new Error('duplicate key'), {
        code: 'ERR_POSTGRES_SERVER_ERROR',
        errno: '23505',
      }),
    );

    await expect(
      withTransaction(
        async () => {
          attempts += 1;
          throw unique;
        },
        { retry: 5 },
      ),
    ).rejects.toBe(unique);

    // Re-running a unique violation produces the same unique violation, five more times.
    expect(attempts).toBe(1);
  });

  test('an exhausted budget names the attempt count and keeps the last driver error', async () => {
    let attempts = 0;

    const caught = await withTransaction(
      async () => {
        attempts += 1;
        throw serialization();
      },
      { retry: 2 },
    ).catch((error: unknown) => error as DbError);

    expect(attempts).toBe(3);
    expect(caught.code).toBe('X_DB_SERIALIZATION_FAILURE');
    expect(caught.cause).toContain('all 3 attempts');
    expect(caught.meta).toMatchObject({ attempts: 3 });
  });

  test('retry inside another transaction is refused, never silently dropped', async () => {
    // Measured against Postgres 17: a 40001 aborts the WHOLE transaction, so the
    // `ROLLBACK TO SAVEPOINT` that would start attempt two answers `25P01`. There is nothing to
    // retry into, and an author who believes they have a budget they do not have is worse off.
    await expect(
      withTransaction(async () => {
        await withTransaction(async () => undefined, { retry: 3 });
      }),
    ).rejects.toThrow('X_INVARIANT');
  });

  test('retry: 0 nested is fine — it is the default, not a request', async () => {
    await withTransaction(async () => {
      await withTransaction(async () => undefined, { retry: 0 });
    });

    expect(client.texts).toContain('SAVEPOINT x_sp_1');
  });
});

describe('tx.origin', () => {
  test('names the client the transaction was opened on, not the pin it runs statements through', async () => {
    // What tier 2 could not answer, and had to refuse instead: a repository pinned to a shard
    // sends its writes to that shard's pool while the BEGIN sits on a connection this scope
    // reserved, so the write commits immediately and survives the rollback. `origin` is the
    // comparison that turns the refusal into the case working.
    const shard = createRecordingClient();
    const { client: pinned, pins } = reservableOver(shard);

    const seen = await withTransaction(async (tx) => tx.origin, { client: pinned });

    expect(seen).toBe(pinned);
    // The reservation is what statements run on, and it is deliberately NOT what `origin` reports:
    // a caller asking "which database is this" must not have to know a pin exists.
    expect(pins).toEqual({ reserves: 1, releases: 1 });
  });

  test('defaults to the ambient client, so an unpinned repository matches', async () => {
    const seen = await withTransaction(async (tx) => tx.origin);

    expect(seen).toBe(client);
  });

  test('a nested scope reports the root, because a SAVEPOINT belongs to the transaction', async () => {
    let inner: DbClient | undefined;
    const outer = await withTransaction(async (tx) => {
      await withTransaction(async (nested) => {
        inner = nested.origin;
      });
      return tx.origin;
    });

    expect(inner).toBe(outer);
    expect(inner).toBe(client);
  });
});
