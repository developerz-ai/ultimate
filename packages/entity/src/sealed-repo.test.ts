// The sealing seam on its own, against a repository that records what reached it: what a driver is
// handed is sealed, what a caller gets back is not, and neither driver is involved in proving it.
// The declaration rules a sealed column carries are here too — both are what holds before a row
// ever reaches a database; `sealed-column.test.ts` is the two drivers end to end.

import { afterAll, describe, expect, test } from 'bun:test';
import {
  classifyThrown,
  isSealed,
  isUltimateError,
  registerErrorRetry,
  sealedKeyId,
} from '@ultimat3/core';
import { integer, text, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { ENTITY_ERROR_RETRY } from './entity-error';
import { invariant } from './invariants';
import { memoryRepo } from './memory-repo';
import { clearRegistry } from './registry';
import type { Repo } from './repo';
import { sealedFields } from './sealed';
import { sealedRepo } from './sealed-repo';

afterAll(() => {
  clearRegistry();
});

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not an UltimateError';
  }
  return 'resolved';
};

const connections = entity('sr_connections', {
  columns: {
    id: uuid().primaryKey(),
    label: text({ max: 40 }),
    password: text({ max: 12 }).sealed(),
    token: text().nullable().sealed(),
    email: text().sealed({ lookup: true }).unique(),
  },
});

describe('unit · the sealing seam', () => {
  /** A repository that records what reached it and stores nothing. */
  const recording = (): { repo: Repo<Record<string, unknown>>; seen: unknown[] } => {
    const seen: unknown[] = [];
    const keep = async (value: unknown) => {
      seen.push(value);
      return value as Record<string, unknown>;
    };
    const repo = {
      findById: async () => null,
      findMany: async (args: unknown) => {
        seen.push(args);
        return { rows: [], nextCursor: null };
      },
      insert: keep,
      insertAll: async (rows: readonly unknown[]) => {
        seen.push(...rows);
        return rows as Record<string, unknown>[];
      },
      upsertAll: async (rows: readonly unknown[]) => {
        seen.push(...rows);
        return rows as Record<string, unknown>[];
      },
      update: async (_id: unknown, patch: unknown) => keep(patch),
      delete: async () => undefined,
      deleteWhere: async () => 0,
      updateWhere: async (_filter: unknown, patch: unknown) => {
        seen.push(patch);
        return 1;
      },
      count: async () => 0,
      countBy: async () => new Map(),
      aggregate: async () => null,
      approximateCount: async () => null,
    } as unknown as Repo<Record<string, unknown>>;
    return { repo, seen };
  };

  test('every write path hands the driver sealed strings, and never the caller`s object', async () => {
    const { repo, seen } = recording();
    const sealing = sealedRepo(connections, repo);
    const row = { id: 'i', label: 'l', password: 'hunter2', token: null, email: 'e@example.com' };
    const made = await sealing.insert(row);
    // The row back is the caller's to READ by name and nothing's to enumerate (`serverOnly`), so
    // `toEqual(row)` no longer holds: equality walks enumerable properties, and these are not.
    expect(made).toEqual({ id: 'i', label: 'l' });
    expect([made['password'], made['token'], made['email']]).toEqual([
      'hunter2',
      null,
      'e@example.com',
    ]);
    await sealing.insertAll([row]);
    await sealing.upsertAll([row], { onConflict: ['email'] });
    await sealing.update('i', { password: 'next' });
    await sealing.updateWhere({ label: 'l' }, { token: 'tok' });
    expect(row.password).toBe('hunter2');
    expect(seen).toHaveLength(5);
    for (const reached of seen) {
      expect(JSON.stringify(reached)).not.toMatch(/hunter2|next|"tok"|e@example\.com/);
    }
    const [inserted] = seen as readonly Record<string, unknown>[];
    expect(isSealed(inserted?.['password'])).toBe(true);
    expect(inserted?.['token']).toBeNull();
    expect(inserted?.['label']).toBe('l');
    expect(sealedKeyId(String(inserted?.['password']))).toHaveLength(16);
  });

  test('an opaque seal is fresh every time; a lookup seal is the same string', async () => {
    const { repo, seen } = recording();
    const sealing = sealedRepo(connections, repo);
    const row = { id: 'i', label: 'l', password: 'same', token: null, email: 'same@example.com' };
    await sealing.insert(row);
    await sealing.insert(row);
    const [a, b] = seen as readonly Record<string, unknown>[];
    expect(a?.['password']).not.toBe(b?.['password']);
    expect(a?.['email']).toBe(b?.['email']);
    // The lookup predicate is that same string, so the database's `=` finds it.
    await sealing.findMany({ where: [{ column: 'email', op: 'eq', value: 'same@example.com' }] });
    expect(seen[2]).toEqual({ where: [{ column: 'email', op: 'eq', value: a?.['email'] }] });
  });

  test('an upsert may collide on a lookup column and never on an opaque one', async () => {
    const sealing = sealedRepo(connections, recording().repo);
    const row = { id: 'i', label: 'l', password: 'p', token: null, email: 'e@example.com' };
    expect(await codeOf(() => sealing.upsertAll([row], { onConflict: ['password'] }))).toBe(
      'X_ENTITY_SEALED_PREDICATE',
    );
  });

  test('an entity with no sealed column gets its repository back untouched', () => {
    const plain = entity('sc_plain', { columns: { id: uuid().primaryKey(), n: integer() } });
    const { repo } = recording();
    expect(sealedRepo(plain, repo)).toBe(repo);
    expect(sealedFields(plain)).toEqual([]);
  });

  test('memoryRepo keeps reset(), and refuses a seed it could only store unsealed', async () => {
    const repo = memoryRepo(connections);
    await repo.insert({
      id: crypto.randomUUID(),
      label: 'l',
      password: 'p',
      token: null,
      email: 'm@example.com',
    });
    repo.reset();
    expect((await repo.findMany()).rows).toEqual([]);
    const seed = [{ id: 'i', label: 'l', password: 'p', token: null, email: 'e@example.com' }];
    expect(() => memoryRepo(connections, seed)).toThrow(/insertAll\(rows\)/);
  });
});

describe('unit · sealing a column that already holds plaintext', () => {
  // The documented update — expand, backfill, contract — as the entity layer sees it. There is no
  // reading of an unsealed row, so the old column stays plain until the new one is populated.
  const expanded = entity('sc_expand', {
    columns: {
      id: uuid().primaryKey(),
      password: text().nullable(),
      passwordSealed: text().nullable().sealed(),
    },
  });

  test('one handle call reads the old column and writes the sealed one, and replays', async () => {
    const table = database({ expanded }, { driver: memoryDriver() }).expanded;
    await table.insertAll([{ password: 'one' }, { password: 'two' }, { password: null }]);
    // The backfill's `handle`, run twice: at-least-once is the contract, so it must be idempotent.
    for (const _pass of [1, 2]) {
      for (const row of await table.all()) {
        await table.update(row.id, { passwordSealed: row.password });
      }
    }
    const rows = await table.all();
    expect(rows.map((row) => row.passwordSealed).sort()).toEqual([null, 'one', 'two'].sort());
    expect(rows.every((row) => row.passwordSealed === row.password)).toBe(true);
  });

  test('the contracted declaration keeps the stored values readable under the old name', async () => {
    // `.column()` pins the physical column, and the purpose is derived from it — so the property
    // can take the old name back without a re-seal.
    const before = sealedFields(expanded).map((field) => field.purpose);
    const contracted = entity('sc_contract', {
      table: 'sc_expand',
      columns: { id: uuid().primaryKey(), password: text().sealed().column('password_sealed') },
    });
    expect(sealedFields(contracted).map((field) => field.purpose)).toEqual(before);
    expect(before).toEqual(['entity:sc_expand.password_sealed']);
  });
});

describe('unit · the sealed refusals are terminal', () => {
  test('a job that hits one stops, instead of spending its retry policy on a declaration', async () => {
    // Re-registered here: the table is process-wide, and another file's reset may have emptied it.
    registerErrorRetry(ENTITY_ERROR_RETRY);
    expect(ENTITY_ERROR_RETRY).toEqual({
      X_ENTITY_SEALED_PREDICATE: 'terminal',
      X_ENTITY_SEALED_IN_VIEW: 'terminal',
    });
    const repo = memoryRepo(connections);
    const thrown = await repo
      .findMany({ where: [{ column: 'password', op: 'eq', value: 'x' }] })
      .catch((error: unknown) => error);
    expect(classifyThrown(thrown)).toBe('terminal');
    const view = (() => {
      try {
        return connections.$view(['id', 'password']);
      } catch (error) {
        return error;
      }
    })();
    expect(classifyThrown(view)).toBe('terminal');
  });
});

describe('unit · what a sealed column may not be', () => {
  const code = (declare: () => unknown): string => {
    try {
      declare();
    } catch (error) {
      return isUltimateError(error) ? `${error.code}: ${error.fix}` : 'not an UltimateError';
    }
    return 'declared';
  };
  const id = { id: uuid().primaryKey() };

  test('unique without lookup, on the chain in either order', () => {
    expect(code(() => text().sealed().unique())).toContain('X_ENTITY_SEALED_PREDICATE');
    expect(code(() => text().unique().sealed())).toContain(
      'text().sealed({ lookup: true }).unique()',
    );
    expect(code(() => text().unique().sealed({ lookup: true }))).toBe('declared');
  });

  test('a default, a key, the tenant, a foreign key, a search source', () => {
    for (const declare of [
      () => text().default('x').sealed(),
      () => text().sealed().default('x'),
      () => text().sealed().primaryKey(),
      () => text().sealed().tenant(),
      () =>
        text()
          .sealed()
          .references(() => id.id),
      () => text().sealed().searchable(),
    ]) {
      expect(code(declare)).toStartWith('X_INVARIANT_VIOLATED');
    }
  });

  test('a composite key, an index and an invariant that name one', () => {
    const columns = () => ({
      ...{ id: uuid().primaryKey() },
      secret: text().sealed(),
      n: integer(),
    });
    expect(
      code(() =>
        entity('sc_bad_pk', {
          columns: { a: uuid(), secret: text().sealed() },
          primaryKey: ['a', 'secret'],
        }),
      ),
    ).toStartWith('X_INVARIANT_VIOLATED');
    expect(
      code(() => entity('sc_bad_index', { columns: columns(), indexes: [{ on: ['secret'] }] })),
    ).toStartWith('X_ENTITY_SEALED_PREDICATE');
    expect(
      code(() =>
        entity('sc_bad_rule', {
          columns: columns(),
          invariants: (c) => [invariant('secret_long', c.secret.minLength(8))],
        }),
      ),
    ).toStartWith('X_ENTITY_SEALED_PREDICATE');
    // A lookup column may be indexed and may be unique across columns — that is what it is for.
    expect(
      code(() =>
        entity('sc_good_index', {
          columns: {
            ...{ id: uuid().primaryKey() },
            email: text().sealed({ lookup: true }),
            n: integer(),
          },
          indexes: [{ on: ['n', 'email'], unique: true }],
        }),
      ),
    ).toBe('declared');
  });

  test('the tenant column, and a multi-column unique that names an opaque one', () => {
    expect(
      code(() =>
        entity('sc_bad_tenant', {
          columns: { id: uuid().primaryKey(), owner: text().sealed() },
          tenant: 'owner',
        }),
      ),
    ).toStartWith('X_INVARIANT_VIOLATED');
    const columns = () => ({ id: uuid().primaryKey(), secret: text().sealed(), n: integer() });
    expect(
      code(() =>
        entity('sc_bad_unique', {
          columns: columns(),
          invariants: (c) => [invariant('one_secret', c.unique(['n', 'secret']))],
        }),
      ),
    ).toContain('text().sealed({ lookup: true })');
  });

  test('.column() keeps the column sealed, and names the purpose', () => {
    const renamed = entity('sc_renamed', {
      columns: { id: uuid().primaryKey(), apiKey: text().sealed().column('key_sealed') },
    });
    expect(sealedFields(renamed)).toEqual([
      expect.objectContaining({
        property: 'apiKey',
        column: 'key_sealed',
        purpose: 'entity:sc_renamed.key_sealed',
        lookup: false,
      }),
    ]);
  });

  test('a view that names one is X_ENTITY_SEALED_IN_VIEW, naming the key to remove', () => {
    const refused = code(() => connections.$view(['id', 'password']));
    expect(refused).toStartWith('X_ENTITY_SEALED_IN_VIEW');
    expect(refused).toContain("remove 'password' from the $view([...]) list");
    expect(code(() => connections.$view(['id', 'email']))).toStartWith('X_ENTITY_SEALED_IN_VIEW');
    expect(connections.$view(['id', 'label']).$keys).toEqual(['id', 'label']);
  });
});
