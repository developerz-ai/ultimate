import { beforeEach, describe, expect, test } from 'bun:test';
import { setDbClient } from './client';
import { createRecordingClient, type RecordingClient } from './fake';
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
