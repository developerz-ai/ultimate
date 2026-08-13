import { beforeEach, describe, expect, test } from 'bun:test';
import { type DbClient, setDbClient } from './client';
import { dbUnavailable } from './errors';
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
