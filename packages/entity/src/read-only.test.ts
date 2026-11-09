// `entity({ readOnly: '<why>' })`: a table the app only reads — legacy history behind a trigger
// that refuses every INSERT, a table another system writes. The reason is required, it rides the
// projection, and both drivers refuse every write path before any statement exists.

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { DbClient } from '@ultimat3/db';
import { text, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';
import type { Repo } from './repo';

afterAll(() => {
  clearRegistry();
});

const REASON = 'pre-2024 orders: kept to read, a trigger refuses every insert';

const legacy = entity('ro_legacy_orders', {
  columns: { id: uuid().primaryKey(), note: text({ max: 40 }) },
  readOnly: REASON,
});
const open = entity('ro_open', { columns: { id: uuid().primaryKey(), note: text({ max: 40 }) } });

const ID = '00000000-0000-7000-8000-000000000001';

const refusedWith = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
    return 'resolved';
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not coded';
  }
};

const declared = (init: object): string => {
  try {
    entity('ro_declared', {
      columns: { id: uuid().primaryKey(), note: text({ max: 40 }) },
      ...init,
    });
    return 'declared';
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not coded';
  } finally {
    clearRegistry();
  }
};

/** Every write a `Repo` exposes, each against `repo`. */
const writes = (repo: Repo<Record<string, unknown>>) =>
  ({
    insert: () => repo.insert({ id: ID, note: 'n' }),
    insertAll: () => repo.insertAll([{ id: ID, note: 'n' }]),
    upsertAll: () => repo.upsertAll([{ id: ID, note: 'n' }], { onConflict: ['id'] }),
    update: () => repo.update(ID, { note: 'm' }),
    delete: () => repo.delete(ID),
    updateWhere: () => repo.updateWhere({ id: ID }, { note: 'm' }),
    deleteWhere: () => repo.deleteWhere({ id: ID }),
    lock: () => repo.lock?.(ID, async () => undefined) ?? Promise.resolve(),
  }) as const;

describe('readOnly · the declaration', () => {
  test('the reason is on the entity and on the projection; absent means writable', () => {
    expect(legacy.$readOnly).toBe(REASON);
    expect(legacy.$describe().readOnly).toBe(REASON);
    expect(open.$readOnly).toBeNull();
    // Absent, never null: `x verify` hashes this projection, and an entity that never said
    // `readOnly` must hash what it hashed before the option existed.
    expect(Object.hasOwn(open.$describe(), 'readOnly')).toBe(false);
  });

  test('a blank reason is refused, and so is a second way to say the same thing', () => {
    expect(declared({ readOnly: '  ' })).toBe('X_INVARIANT_VIOLATED');
    expect(declared({ readOnly: REASON, appendOnly: true })).toBe('X_INVARIANT_VIOLATED');
    expect(declared({ readOnly: REASON, view: { sql: 'select 1 as id, $$n$$ as note' } })).toBe(
      'X_INVARIANT_VIOLATED',
    );
    expect(declared({ readOnly: REASON })).toBe('declared');
  });
});

describe('readOnly · every write path, both drivers, before any statement', () => {
  test('memory: each write rejects X_ENTITY_READ_ONLY, and a read answers', async () => {
    const driver = memoryDriver();
    const repo = driver.repo(legacy) as Repo<Record<string, unknown>>;
    for (const [name, write] of Object.entries(writes(repo))) {
      expect({ name, code: await refusedWith(write) }).toEqual({
        name,
        code: 'X_ENTITY_READ_ONLY',
      });
    }
    expect((await repo.findMany({})).rows).toEqual([]);
    const db = database({ legacy }, { driver });
    expect(await refusedWith(() => db.legacy.insert({ id: ID, note: 'n' }))).toBe(
      'X_ENTITY_READ_ONLY',
    );
  });

  test('postgres: each write rejects before the client is asked anything', async () => {
    let asked = 0;
    const refuse = (): never => {
      asked += 1;
      return expect.unreachable('a read-only write reached the client');
    };
    const client = { query: refuse, one: refuse, execute: refuse } as unknown as DbClient;
    const repo = postgresRepo(legacy as never, { client }) as Repo<Record<string, unknown>>;
    for (const [name, write] of Object.entries(writes(repo))) {
      expect({ name, code: await refusedWith(write) }).toEqual({
        name,
        code: 'X_ENTITY_READ_ONLY',
      });
    }
    expect(asked).toBe(0);
  });

  test('the refusal names the entity, the operation and the reason, and its fix the declaration', async () => {
    const repo = memoryDriver().repo(legacy) as Repo<Record<string, unknown>>;
    try {
      await repo.insert({ id: ID, note: 'n' });
    } catch (error) {
      if (!isUltimateError(error)) return expect.unreachable('not coded');
      expect(error.cause).toContain('ro_legacy_orders.insert()');
      expect(error.cause).toContain(REASON);
      expect(error.fix).toContain('x entities show ro_legacy_orders --json');
      return;
    }
    expect.unreachable('the read-only insert resolved');
  });
});
