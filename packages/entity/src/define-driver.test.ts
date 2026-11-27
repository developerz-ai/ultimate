// `defineDriver` is the door a third-party store (Mongo, Cassandra, a key-value store) comes in by.
// The toy below is the whole of a driver: a Map per table, read through the kit's own
// `selectRows`. Every guard the framework owes — tenancy, soft delete, page bounds, cursors,
// invariants — is the kit's, so a driver that forgets one still cannot leak another tenant's row.

import { afterAll, describe, expect, test } from 'bun:test';
import { ctxOf, isUltimateError, runWithContext, userActor } from '@ultimat3/core';
import { selectRows } from './adapter';
import { integer, text, timestamp, uuid } from './columns';
import { bigint } from './columns-data';
import { type Driver, database, memoryDriver } from './database';
import { type DriverDefinition, type DriverRepo, defineDriver } from './define-driver';
import { entityUniqueViolation } from './driver-errors';
import { type EntityCore, entity } from './entity';
import { invariant } from './invariants';
import { clearRegistry } from './registry';
import type { Repo } from './repo';

afterAll(() => {
  clearRegistry();
});

const notes = entity('driver_kit_notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    rank: integer(),
    body: text({ max: 40 }),
    deletedAt: timestamp().nullable(),
  },
  invariants: (c) => [invariant('driver_kit_rank_non_negative', c.rank.atLeast(0))],
});
type Note = typeof notes.$row;

const idAt = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ORG = idAt(900);
const OTHER = idAt(901);
const note = (n: number, orgId = ORG): Note => ({
  id: idAt(n),
  orgId,
  rank: n % 4,
  body: `note ${n}`,
  deletedAt: null,
});

const asOrg = <T>(orgId: string, work: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: idAt(990), orgId }) }), work);

const codeOf = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not an UltimateError';
  }
  return 'resolved';
};
const capabilityOf = async (work: () => Promise<unknown>): Promise<unknown> => {
  try {
    await work();
  } catch (error) {
    return isUltimateError(error) ? error.meta?.['capability'] : undefined;
  }
  return 'resolved';
};

/** The toy store: twenty lines, and it knows nothing about tenants, cursors or soft delete. */
const toyStore = (overrides: Partial<DriverRepo<unknown>> = {}): DriverDefinition => {
  const tables = new Map<string, Map<string, unknown>>();
  return {
    name: 'toy',
    capabilities: [],
    repo: <Row>(table: EntityCore<Row>): DriverRepo<Row> => {
      const rows = (tables.get(table.$name) ?? new Map<string, Row>()) as Map<string, Row>;
      tables.set(table.$name, rows as Map<string, unknown>);
      const keyOf = (row: Row): string =>
        JSON.stringify(table.$primaryKey.map((key) => (row as Record<string, unknown>)[key]));
      const matched = (where: Parameters<DriverRepo<Row>['count']>[0]): Row[] =>
        selectRows(table, rows.values(), { plan: where.plan, after: undefined, limit: rows.size });
      return {
        select: async (read) => selectRows(table, rows.values(), read),
        count: async (where) => matched(where).length,
        insert: async (batch) => {
          for (const row of batch) {
            if (rows.has(keyOf(row))) throw entityUniqueViolation(table, `${table.$table}_pkey`);
          }
          for (const row of batch) rows.set(keyOf(row), row);
          return batch;
        },
        update: async (where, patch) => {
          const hit = matched(where);
          for (const row of hit) rows.set(keyOf(row), { ...row, ...patch });
          return hit.length;
        },
        delete: async (where) => {
          const hit = matched(where);
          for (const row of hit) rows.delete(keyOf(row));
          return hit.length;
        },
        ...(overrides as Partial<DriverRepo<Row>>),
      };
    },
    reset: () => tables.clear(),
  };
};

const ROWS: readonly Note[] = [
  ...Array.from({ length: 7 }, (_, n) => note(n + 1)),
  note(50, OTHER),
];

/** The repository `database()` reads through, seeded outside any request as a script would be. */
const seeded = async (driver: Driver = defineDriver(toyStore())): Promise<Repo<Note>> => {
  const repo = driver.repo(notes);
  await repo.insertAll(ROWS);
  return repo;
};

describe('reads: the kit scopes the plan before the store sees it', () => {
  test('pages under an actor match the memory driver, cursor for cursor', async () => {
    const memory = await seeded(memoryDriver());
    const toy = await seeded();
    const walk = async (repo: Repo<Note>): Promise<string[][]> =>
      asOrg(ORG, async () => {
        const pages: string[][] = [];
        let cursor: string | null = null;
        do {
          const page = await repo.findMany({
            orderBy: [{ column: 'rank', direction: 'desc' }],
            limit: 3,
            cursor,
          });
          pages.push(page.rows.map((row) => row.id));
          cursor = page.nextCursor;
        } while (cursor !== null);
        return pages;
      });
    const expected = await walk(memory);
    expect(expected.flat()).toHaveLength(7);
    expect(await walk(toy)).toEqual(expected);
  });

  test('a store that ignores `where` cannot hand another tenant’s row back', async () => {
    const leaky = toyStore({
      // Every row the table holds, whatever the plan said: the bug a third-party driver ships.
      select: async (read) =>
        selectRows(notes, [note(1), note(50, OTHER)], {
          plan: { ...read.plan, where: [] },
          after: undefined,
          limit: read.limit,
        }),
    });
    const repo = defineDriver(leaky).repo(notes);
    expect(await codeOf(() => asOrg(ORG, () => repo.findMany({})))).toBe(
      'X_DRIVER_ROW_OUT_OF_SCOPE',
    );
    expect(await codeOf(() => asOrg(ORG, () => repo.findById(idAt(50))))).toBe(
      'X_DRIVER_ROW_OUT_OF_SCOPE',
    );
  });

  test('another tenant’s id is not found; an unscoped read is refused before the store', async () => {
    const repo = await seeded();
    expect(await asOrg(ORG, () => repo.findById(idAt(50)))).toBeNull();
    expect(await codeOf(() => repo.findMany({}))).toBe('X_TENANCY_UNSCOPED');
  });

  test('select projects as Postgres does: the asked columns, the key and the sort keys', async () => {
    const repo = await seeded();
    const page = await asOrg(ORG, () => repo.findMany({ select: ['body'], limit: 1 }));
    expect(Object.keys(page.rows[0] as object).sort()).toEqual(['body', 'id']);
  });

  test('a full-text predicate on a store that declares no `matches` is refused', async () => {
    const repo = await seeded();
    const capability = await capabilityOf(() =>
      asOrg(ORG, () =>
        repo.findMany({ where: [{ column: '$search', op: 'matches', value: 'x' }] }),
      ),
    );
    expect(capability).toBe('matches');
  });
});

describe('writes: tenancy, invariants and soft delete are the kit’s', () => {
  test('a row naming another tenant is refused before the store writes', async () => {
    const repo = await seeded();
    expect(await codeOf(() => asOrg(ORG, () => repo.insert(note(60, OTHER))))).toBe(
      'X_TENANCY_ACTOR_MISMATCH',
    );
    expect(await asOrg(OTHER, () => repo.count({}))).toBe(1);
  });

  test('an update an invariant refuses never reaches the store', async () => {
    const repo = await seeded();
    expect(await codeOf(() => asOrg(ORG, () => repo.update(idAt(1), { rank: -1 })))).toBe(
      'X_INVARIANT_VIOLATED',
    );
    expect((await asOrg(ORG, () => repo.findById(idAt(1))))?.rank).toBe(1);
  });

  test('update answers the row as stored; another tenant’s id is X_NOT_FOUND', async () => {
    const repo = await seeded();
    const after = await asOrg(ORG, () => repo.update(idAt(2), { body: 'edited' }));
    expect(after.body).toBe('edited');
    expect(await codeOf(() => asOrg(ORG, () => repo.update(idAt(50), { body: 'x' })))).toBe(
      'X_NOT_FOUND',
    );
  });

  test('delete on a soft-delete entity stamps and hides; filtered writes count', async () => {
    const repo = await seeded();
    await asOrg(ORG, () => repo.delete(idAt(3)));
    expect(await asOrg(ORG, () => repo.findById(idAt(3)))).toBeNull();
    const hidden = await asOrg(ORG, () => repo.findById(idAt(3), { includeDeleted: true }));
    expect(hidden?.deletedAt).toBeInstanceOf(Date);
    expect(await asOrg(ORG, () => repo.updateWhere({ rank: 1 }, { body: 'r1' }))).toBe(2);
    expect(await asOrg(ORG, () => repo.deleteWhere({ rank: 1 }))).toBe(2);
    expect(await codeOf(() => asOrg(ORG, () => repo.deleteWhere({})))).toBe('X_WRITE_UNFILTERED');
  });

  test('a duplicate key is X_DB_UNIQUE_VIOLATION, the error Postgres raises', async () => {
    const repo = await seeded();
    expect(await codeOf(() => asOrg(ORG, () => repo.insert(note(1))))).toBe(
      'X_DB_UNIQUE_VIOLATION',
    );
  });
});

describe('capabilities: undeclared is refused with the capability named', () => {
  test('upsertAll, aggregates and approximateCount name what is missing', async () => {
    const repo = await seeded();
    expect(
      await capabilityOf(() => asOrg(ORG, () => repo.upsertAll([note(1)], { onConflict: ['id'] }))),
    ).toBe('upsert');
    expect(await capabilityOf(() => asOrg(ORG, () => repo.countBy('rank')))).toBe(
      'aggregate:countBy',
    );
    expect(await capabilityOf(() => asOrg(ORG, () => repo.aggregate('sum', 'rank')))).toBe(
      'aggregate:sum',
    );
  });

  test('no `transactions`: the transactor and a write naming a tx are refused', async () => {
    const driver = defineDriver(toyStore());
    expect(await capabilityOf(async () => driver.transactor())).toBe('transactions');
    const repo = driver.repo(notes);
    const tx = { id: 'foreign', onRollback: () => undefined };
    expect(await capabilityOf(() => asOrg(ORG, () => repo.insert(note(9), { tx })))).toBe(
      'transactions',
    );
  });

  test('lock is absent, so the handle answers the shipped X_LOCK_UNSUPPORTED', async () => {
    const repo = await seeded();
    expect(repo.lock).toBeUndefined();
  });

  test('a declared lock runs on the scoped row; another tenant’s id is X_NOT_FOUND', async () => {
    const held = { id: 'held', onRollback: () => undefined };
    const base = toyStore();
    const locking: DriverDefinition = {
      ...base,
      capabilities: ['lock'],
      repo: <Row>(table: EntityCore<Row>): DriverRepo<Row> => {
        const inner = base.repo<Row>(table);
        return {
          ...inner,
          lock: async (filter, fn) => {
            const [row] = await inner.select({ ...filter, after: undefined, limit: 1 });
            return fn(row ?? null, held);
          },
          lockKey: async (_key, fn) => fn(held),
        };
      },
    };
    const repo = await seeded(defineDriver(locking));
    const lock = repo.lock;
    if (lock === undefined) return expect.unreachable('lock was declared');
    expect(await asOrg(ORG, () => lock(idAt(2), (row) => row.body))).toBe('note 2');
    expect(await codeOf(() => asOrg(ORG, () => lock(idAt(50), (row) => row.body)))).toBe(
      'X_NOT_FOUND',
    );
  });

  test('a declared capability with no method behind it is refused when the table is opened', () => {
    let code = 'no throw';
    try {
      // `database()` opens every table's repository as it is called, so this is the app's boot.
      database({ notes }, { driver: defineDriver({ ...toyStore(), capabilities: ['upsert'] }) });
    } catch (error) {
      code = isUltimateError(error) ? error.code : 'not an UltimateError';
    }
    expect(code).toBe('X_DRIVER_CAPABILITY_MISSING');
  });
});

describe('the cursor names a row by its key as the shipped drivers spell it', () => {
  const counters = entity('driver_kit_counters', {
    columns: { id: bigint().primaryKey(), label: text({ max: 20 }) },
  });

  /** A store handing back what its own client decodes: an `int8` as a JS `bigint`. */
  const nativeBigints: DriverDefinition = {
    name: 'native',
    capabilities: [],
    repo: <Row>(): DriverRepo<Row> => {
      const rows = [1n, 2n, 3n].map((id) => ({ id, label: `n${id}` })) as unknown as Row[];
      return {
        select: async (read) => selectRows(counters as never, rows, read),
        count: async () => rows.length,
        insert: async (batch) => batch,
        update: async () => 0,
        delete: async () => 0,
      };
    },
  };

  test('a store returning a native bigint key pages instead of throwing', async () => {
    const repo = defineDriver(nativeBigints).repo(counters);
    const first = await repo.findMany({ limit: 2 });
    expect(first.nextCursor).not.toBeNull();
    const second = await repo.findMany({ limit: 2, cursor: first.nextCursor });
    expect(second.rows.map((row) => String(row.id))).toEqual(['3']);
  });

  test('a store spelling a uuid key upper-case gets the cursor id keyOf spells', async () => {
    const ids = ['abcdef01-0000-7000-8000-00000000000a', 'abcdef01-0000-7000-8000-00000000000b'];
    const shouting = toyStore({
      select: async (read) =>
        selectRows(
          notes,
          ids.map((id) => ({ ...note(1), id: id.toUpperCase() })),
          read,
        ),
    });
    const repo = defineDriver(shouting).repo(notes);
    const page = await asOrg(ORG, () => repo.findMany({ limit: 1 }));
    const [payload = ''] = (page.nextCursor ?? '').split('.');
    const [, id] = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown[];
    expect(id).toBe(ids[0]);
  });
});

describe('bug-hunter pass 2', () => {
  test('a filtered write on an entity with no invariant goes straight to the store', async () => {
    const plain = entity('driver_kit_plain', {
      columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), body: text({ max: 20 }) },
    });
    const selects: string[] = [];
    const base = toyStore();
    const watched: DriverDefinition = {
      ...base,
      repo: <Row>(table: EntityCore<Row>): DriverRepo<Row> => {
        const inner = base.repo<Row>(table);
        return {
          ...inner,
          select: (read) => {
            selects.push(table.$name);
            return inner.select(read);
          },
        };
      },
    };
    const repo = defineDriver(watched).repo(plain);
    await repo.insertAll([
      { id: idAt(1), orgId: ORG, body: 'a' },
      { id: idAt(2), orgId: ORG, body: 'a' },
    ]);
    expect(await asOrg(ORG, () => repo.updateWhere({ body: 'a' }, { body: 'b' }))).toBe(2);
    // No read-back: nothing to judge, so no 50,000-row cap blaming an invariant that is not there.
    // (A HARD delete still reads first — it is checked row by row, below.)
    expect(selects).toEqual([]);
    expect(await asOrg(ORG, () => repo.deleteWhere({ body: 'b' }))).toBe(2);
  });

  test("'lock' with lock and no lockKey is refused when the table opens", () => {
    let code = 'no throw';
    try {
      defineDriver({
        ...toyStore({
          lock: async (_filter, fn) => fn(null, { id: 't', onRollback: () => undefined }),
        }),
        capabilities: ['lock'],
      }).repo(notes);
    } catch (error) {
      code = isUltimateError(error) ? error.code : 'not an UltimateError';
    }
    expect(code).toBe('X_DRIVER_CAPABILITY_MISSING');
  });
});

describe('security audit: what a store hands back from a write is checked too', () => {
  const people = entity('driver_kit_people', {
    columns: {
      id: uuid().primaryKey(),
      orgId: uuid().tenant(),
      email: text({ max: 40 }),
      secret: text({ max: 40 }),
    },
    indexes: [{ on: ['email'], unique: true }],
  });
  type Person = typeof people.$row;
  const theirs: Person = { id: idAt(70), orgId: OTHER, email: 'ceo@b.com', secret: 'b-secret' };

  /** Mongo-style: a match on a global unique answers the STORED document, whoever owns it. */
  const answersStored: DriverDefinition = (() => {
    const base = toyStore();
    return {
      ...base,
      capabilities: ['upsert'],
      repo: <Row>(table: EntityCore<Row>): DriverRepo<Row> => {
        const inner = base.repo<Row>(table);
        return {
          ...inner,
          upsert: async (rows) => {
            const stored = await inner.select({
              plan: { entity: table.$name, where: [], orderBy: [], limit: 100 },
              after: undefined,
              limit: 100,
            });
            const email = (row: Row) => (row as Record<string, unknown>)['email'];
            return rows.map((row) => stored.find((each) => email(each) === email(row)) ?? row);
          },
        };
      },
    };
  })();

  test("upsert onMatch 'nothing' cannot return another tenant's row", async () => {
    const repo = defineDriver(answersStored).repo(people);
    await repo.insert(theirs);
    const mine = { id: idAt(71), orgId: ORG, email: 'ceo@b.com', secret: 'a' };
    expect(
      await codeOf(() =>
        asOrg(ORG, () => repo.upsertAll([mine], { onConflict: ['email'], onMatch: 'nothing' })),
      ),
    ).toBe('X_DRIVER_ROW_OUT_OF_SCOPE');
  });

  test("insert cannot return another tenant's row", async () => {
    const lying = toyStore({ insert: async () => [theirs] });
    const repo = defineDriver(lying).repo(people);
    const mine = { id: idAt(72), orgId: ORG, email: 'a@a.com', secret: 'a' };
    expect(await codeOf(() => asOrg(ORG, () => repo.insert(mine)))).toBe(
      'X_DRIVER_ROW_OUT_OF_SCOPE',
    );
  });

  test('a reference into another tenant is refused, as memory and Postgres refuse it', async () => {
    const folders = entity('driver_kit_folders', {
      columns: { id: uuid().primaryKey(), orgId: uuid().tenant() },
    });
    const files = entity('driver_kit_files', {
      columns: {
        id: uuid().primaryKey(),
        orgId: uuid().tenant(),
        folderId: uuid().references(() => folders.id),
      },
    });
    const driver = defineDriver(toyStore());
    await driver.repo(folders).insert({ id: idAt(80), orgId: OTHER });
    await driver.repo(folders).insert({ id: idAt(81), orgId: ORG });
    const repo = driver.repo(files);
    expect(
      await codeOf(() =>
        asOrg(ORG, () => repo.insert({ id: idAt(82), orgId: ORG, folderId: idAt(80) })),
      ),
    ).toBe('X_DB_FOREIGN_KEY_VIOLATION');
    await asOrg(ORG, () => repo.insert({ id: idAt(83), orgId: ORG, folderId: idAt(81) }));
  });

  test('a hard delete checks the rows first and removes only those', async () => {
    const plain = entity('driver_kit_hard', {
      columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), body: text({ max: 20 }) },
    });
    const removed: unknown[] = [];
    const leaky = toyStore({
      // Ignores the plan on both halves: every row, every tenant.
      select: async (read) =>
        selectRows(
          plain,
          [
            { id: idAt(90), orgId: ORG, body: 'x' },
            { id: idAt(91), orgId: OTHER, body: 'x' },
          ],
          { ...read, plan: { ...read.plan, where: [] } },
        ),
      delete: async (filter) => {
        removed.push(filter.plan.where);
        return 1;
      },
    });
    const repo = defineDriver(leaky).repo(plain);
    expect(await codeOf(() => asOrg(ORG, () => repo.deleteWhere({ body: 'x' })))).toBe(
      'X_DRIVER_ROW_OUT_OF_SCOPE',
    );
    expect(removed).toEqual([]);
  });
});
