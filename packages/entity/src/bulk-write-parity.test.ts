// Single responsibility: a many-row write means one thing in both drivers, past the bind ceiling and
// at the edges — `memoryDriver()` and `postgresDriver()` over a real embedded Postgres (PGlite).
// Beside `write-parity.test.ts`, which is at the file ceiling; the statement text is
// `pg-driver-bulk.test.ts`'s, and the 40,000-row probe against a real server its `.live.` twin's.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { MAX_BIND_PARAMETERS } from './bulk-write';
import { text, timestamp, uuid } from './columns';
import { type Driver, database, memoryDriver } from './database';
import { entity } from './entity';
import { invariant } from './invariants';
import { memoryRepo } from './memory-repo';
import { postgresDriver, postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';
import type { Repo } from './repo';
import { defineSeed } from './seed';
import type { RowPatch } from './types';

const PGLITE_BOOT_MS = 30_000;
const WIDE_MS = 60_000;

/** Primary key only: memory's unique check is a scan per row, and this batch is 40,000 of them. */
const wide = entity('bwp_wide', {
  columns: { id: text({ max: 20 }).primaryKey(), label: text({ max: 20 }) },
});

const notes = entity('bwp_notes', {
  columns: {
    id: uuid().primaryKey(),
    code: text({ max: 20 }).unique(),
    title: text({ max: 40 }),
    body: text({ max: 40 }).nullable(),
  },
});

type Note = typeof notes.$row;

const stampHasReason = (deletedAt: unknown, reason: unknown): boolean =>
  deletedAt === null || reason !== null;

/** A rule with no CHECK, over a column an upsert's set list spares and one it overwrites. */
const audited = entity('bwp_audited', {
  columns: {
    id: uuid().primaryKey(),
    code: text({ max: 20 }).unique(),
    reason: text({ max: 40 }).nullable(),
    deletedAt: timestamp().nullable(),
  },
  invariants: (c) => [
    invariant('stamp_has_reason', c.satisfies(stampHasReason, ['deletedAt', 'reason'])),
  ],
});

/** Every kind of column `$parse` fills: a default, a nullable and a `defaultNow()`. */
const filled = entity('bwp_filled', {
  columns: {
    id: uuid().primaryKey(),
    code: text({ max: 20 }).unique(),
    title: text({ max: 40 }),
    label: text({ max: 20 }).default('dflt'),
    note: text({ max: 40 }).nullable(),
    createdAt: timestamp().defaultNow(),
  },
});

const stamps = entity('bwp_stamps', {
  columns: {
    id: uuid().primaryKey(),
    code: text({ max: 20 }).unique(),
    title: text({ max: 40 }),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
});

const pairs = entity('bwp_pairs', {
  columns: { first: text({ max: 20 }), second: text({ max: 20 }), label: text().default('d') },
  primaryKey: ['first', 'second'],
});

/** The same rule with a column two rows share, for a filtered delete that matches both. */
const sweep = entity('bwp_sweep', {
  columns: {
    id: uuid().primaryKey(),
    kind: text({ max: 20 }),
    reason: text({ max: 40 }).nullable(),
    deletedAt: timestamp().nullable(),
  },
  invariants: (c) => [
    invariant('sweep_stamp_has_reason', c.satisfies(stampHasReason, ['deletedAt', 'reason'])),
  ],
});

const ENTITIES = { wide, notes, audited, filled, stamps, pairs, sweep };
const client = pgliteClient();

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: Object.values(ENTITIES).map((one) => one.$describe()),
    name: 'bulk write parity',
    now: new Date('2026-11-02T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

beforeEach(async () => {
  for (const one of Object.values(ENTITIES)) {
    await client.execute(raw(`delete from "${one.$name}"`));
  }
});

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
  clearRegistry();
});

const codeOf = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => 'resolved',
    (error: unknown) => (isUltimateError(error) ? error.code : `not coded: ${String(error)}`),
  );

/** One body, both drivers, the two answers: memory first. Equal is the assertion. */
const both = async <T>(
  body: (db: ReturnType<typeof database<typeof ENTITIES>>) => Promise<T>,
): Promise<readonly [T, T]> => {
  const run = (driver: Driver) => body(database(ENTITIES, { driver }));
  return [await run(memoryDriver()), await run(postgresDriver())] as const;
};

/** A hand-held repository, since `database()`'s `$parse` fills every column a row left out. */
const repos = (): readonly [Repo<Note>, Repo<Note>] => [memoryRepo(notes), postgresRepo(notes)];

const ID = '00000000-0000-7000-8000-000000000001';
const OTHER = '00000000-0000-7000-8000-000000000002';

describe('a batch past the bind ceiling', () => {
  // 2 columns, so one statement carries 32,767 rows and row 35,000 lands in the second.
  const ROWS = 40_000;
  const row = (index: number) => ({ id: `r${index}`, label: 'l' });

  test('is several statements on Postgres, by construction of the numbers here', () => {
    expect(Math.floor(MAX_BIND_PARAMETERS / 2)).toBeLessThan(35_000);
  });

  test(
    'that fails on a duplicate leaves no row, in either driver',
    async () => {
      const batch = Array.from({ length: ROWS }, (_, index) => row(index === 35_000 ? 0 : index));
      const answers = await both(async (db) => [
        await codeOf(db.wide.insertAll(batch)),
        await db.wide.count(),
      ]);
      expect(answers[0]).toEqual(['X_DB_UNIQUE_VIOLATION', 0]);
      expect(answers[1]).toEqual(answers[0]);
    },
    WIDE_MS,
  );
});

describe('a present `undefined` in an upsert is absent, as it is in every other write', () => {
  // `bindValues` skips it and `update(id, { body: undefined })` leaves the column alone. The set
  // list used to name it regardless, so the stored value took the column's default instead: NULL
  // on Postgres, `undefined` in memory, from a batch that never mentioned a new value.
  const stored = { id: ID, code: 'a', title: 'kept', body: 'kept body' };

  test('the stored column keeps its value, in both drivers', async () => {
    for (const repo of repos()) {
      await client.execute(raw('delete from "bwp_notes"'));
      await repo.insert(stored);
      const incoming: RowPatch<Note> = { id: OTHER, code: 'a', title: 'moved', body: undefined };
      const [written] = await repo.upsertAll([incoming as Note], { onConflict: ['code'] });
      expect(written).toEqual({ id: ID, code: 'a', title: 'moved', body: 'kept body' });
    }
  });

  test('a row writing undefined where another writes a value is an uneven batch', async () => {
    for (const repo of repos()) {
      const uneven: readonly RowPatch<Note>[] = [
        { id: ID, code: 'a', title: 't', body: 'new' },
        { id: OTHER, code: 'b', title: 't', body: undefined },
      ];
      const refused = await codeOf(repo.upsertAll(uneven as Note[], { onConflict: ['code'] }));
      expect(refused).toBe('X_INVARIANT_VIOLATED');
    }
  });
});

describe('an upsert lands a row nobody judged', () => {
  // The incoming row is fine and the stored row was: what breaks the rule is the MERGE, here a
  // stamp the set list spares beside a `reason` it overwrites. Only a rule the app alone can judge
  // has this hole, so the row Postgres answered is judged inside a transaction it can undo.
  const stampedRow = {
    id: ID,
    code: 'a',
    reason: 'because',
    deletedAt: null as Date | null,
  };

  test('a merged result breaking a JS-only rule is refused, and the row stays', async () => {
    const memory = memoryRepo(audited);
    const pg = postgresRepo(audited);
    for (const repo of [memory, pg]) {
      await client.execute(raw('delete from "bwp_audited"'));
      await repo.insert(stampedRow);
      await repo.delete(ID);
      const refused = await codeOf(
        repo.upsertAll([{ ...stampedRow, reason: null }], { onConflict: ['code'] }),
      );
      expect(refused).toBe('X_INVARIANT_VIOLATED');
      const { rows } = await repo.findMany({ includeDeleted: true });
      expect(rows.map((row) => row.reason)).toEqual(['because']);
    }
  });

  test("onMatch: 'nothing' merges nothing, so it has nothing to judge", async () => {
    for (const repo of [memoryRepo(audited), postgresRepo(audited)]) {
      await client.execute(raw('delete from "bwp_audited"'));
      await repo.insert(stampedRow);
      const written = await repo.upsertAll([{ ...stampedRow, reason: null }], {
        onConflict: ['code'],
        onMatch: 'nothing',
      });
      expect(written).toEqual([]);
    }
  });
});

describe('db.*.upsertAll overwrites what the caller named, and nothing $parse filled in', () => {
  const WHEN = new Date('2020-01-02T03:04:05.000Z');
  const stored = { code: 'a', label: 'kept', note: 'kept note', title: 'old', createdAt: WHEN };
  type Db = ReturnType<typeof database<typeof ENTITIES>>;
  const seeded = async (db: Db) => {
    await client.execute(raw('delete from "bwp_filled"'));
    await db.filled.insert(stored);
  };

  test('unnamed label, note and createdAt survive a collision, in both drivers', async () => {
    const [memory, pg] = await both(async (db) => {
      await seeded(db);
      const [written] = await db.filled.upsertAll([{ code: 'a', title: 'new' }], {
        onConflict: ['code'],
      });
      return [written?.title, written?.label, written?.note, written?.createdAt];
    });
    expect(memory).toEqual(['new', 'kept', 'kept note', WHEN]);
    expect(pg).toEqual(memory);
  });

  test('a new row in the same batch still takes the defaults $parse filled', async () => {
    const [memory, pg] = await both(async (db) => {
      await seeded(db);
      const written = await db.filled.upsertAll(
        [
          { code: 'a', title: 'new' },
          { code: 'b', title: 'fresh' },
        ],
        { onConflict: ['code'] },
      );
      return written.map((row) => [row.code, row.label, row.note]);
    });
    expect(memory).toEqual([
      ['a', 'kept', 'kept note'],
      ['b', 'dflt', null],
    ]);
    expect(pg).toEqual(memory);
  });

  test('the uneven-batch refusal is reachable, and nothing is written', async () => {
    const [memory, pg] = await both(async (db) => {
      await seeded(db);
      const code = await codeOf(
        db.filled.upsertAll(
          [
            { code: 'a', title: 't', note: 'new' },
            { code: 'b', title: 't' },
          ],
          { onConflict: ['code'] },
        ),
      );
      return [code, await db.filled.count()];
    });
    expect(memory).toEqual(['X_INVARIANT_VIOLATED', 1]);
    expect(pg).toEqual(memory);
  });

  test('naming only the target writes nothing, so it is refused with the other mode', async () => {
    const [memory, pg] = await both((db) =>
      codeOf(db.filled.upsertAll([{ code: 'a', title: 'old' }], { onConflict: ['code', 'title'] })),
    );
    expect(memory).toBe(pg);
    const [keysOnly] = await both((db) =>
      codeOf(
        db.pairs.upsertAll([{ first: 'a', second: 'b' }], { onConflict: ['first', 'second'] }),
      ),
    );
    expect(keysOnly).toBe('X_INVARIANT_VIOLATED');
  });

  test('onUpdateNow moves on a collision, though no caller named it', async () => {
    const [memory, pg] = await both(async (db) => {
      await client.execute(raw('delete from "bwp_stamps"'));
      const first = await db.stamps.insert({ code: 'a', title: 'one', updatedAt: WHEN });
      const [second] = await db.stamps.upsertAll([{ code: 'a', title: 'two' }], {
        onConflict: ['code'],
      });
      return [
        first.updatedAt.getTime() === WHEN.getTime(),
        second?.updatedAt.getTime() !== WHEN.getTime(),
      ];
    });
    expect(memory).toEqual([true, true]);
    expect(pg).toEqual(memory);
  });

  test("onMatch: 'nothing' still inserts the filled row and leaves the stored one", async () => {
    const [memory, pg] = await both(async (db) => {
      await seeded(db);
      const written = await db.filled.upsertAll(
        [
          { code: 'a', title: 'x' },
          { code: 'c', title: 'y' },
        ],
        { onConflict: ['code'], onMatch: 'nothing' },
      );
      return written.map((row) => [row.code, row.label]);
    });
    expect(memory).toEqual([['c', 'dflt']]);
    expect(pg).toEqual(memory);
  });
});

describe('a seed upsert overwrites what the seed named', () => {
  test('a column it never mentioned keeps its stored value on a changed re-run', async () => {
    const answers: unknown[] = [];
    for (const driver of [memoryDriver(), postgresDriver()]) {
      await client.execute(raw('delete from "bwp_filled"'));
      const db = database(ENTITIES, { driver });
      await db.filled.insert({ code: 'a', title: 'old', label: 'kept', note: 'kept note' });
      const seed = defineSeed('bwp_replay', async ({ upsert }) => {
        answers.push(await upsert(filled, { by: ['code'] }, { code: 'a', title: 'new' }));
      });
      await seed.run({ driver });
      const row = await db.filled.where({ code: 'a' }).one();
      answers.push([row?.title, row?.label, row?.note]);
    }
    const expected = ['updated', ['new', 'kept', 'kept note']];
    expect(answers).toEqual([...expected, ...expected]);
  });
});

describe('a soft delete is an update, and a JS-only rule judges it in both drivers', () => {
  const row = (id: string, code: string, reason: string | null) => ({
    id,
    code,
    reason,
    deletedAt: null,
  });

  test('delete(id) that breaks the rule is refused, and the row stays', async () => {
    for (const repo of [memoryRepo(audited), postgresRepo(audited)]) {
      await client.execute(raw('delete from "bwp_audited"'));
      await repo.insert(row(ID, 'a', null));
      expect(await codeOf(repo.delete(ID))).toBe('X_INVARIANT_VIOLATED');
      expect(await repo.count({})).toBe(1);
    }
  });

  test('deleteWhere over a mixed set refuses as one', async () => {
    for (const repo of [memoryRepo(sweep), postgresRepo(sweep)]) {
      await client.execute(raw('delete from "bwp_sweep"'));
      await repo.insertAll([
        { id: ID, kind: 'k', reason: 'fine', deletedAt: null },
        { id: OTHER, kind: 'k', reason: null, deletedAt: null },
      ]);
      expect(await codeOf(repo.deleteWhere({ kind: 'k' }))).toBe('X_INVARIANT_VIOLATED');
      expect(await repo.count({})).toBe(2);
    }
  });

  test('a passing rule still deletes, and answers the count', async () => {
    for (const repo of [memoryRepo(sweep), postgresRepo(sweep)]) {
      await client.execute(raw('delete from "bwp_sweep"'));
      await repo.insert({ id: ID, kind: 'k', reason: 'fine', deletedAt: null });
      expect(await repo.deleteWhere({ kind: 'k' })).toBe(1);
      expect(await repo.count({})).toBe(0);
    }
  });
});

describe('an empty batch', () => {
  test('writes nothing and answers empty, and a bad target is still refused', async () => {
    const [memory, pg] = await both(async (db) => [
      await db.notes.insertAll([]),
      await db.notes.upsertAll([], { onConflict: ['code'] }),
      await db.notes.count(),
      await codeOf(db.notes.upsertAll([], { onConflict: ['title'] })),
    ]);
    expect(memory).toEqual([[], [], 0, 'X_INVARIANT_VIOLATED']);
    expect(pg).toEqual(memory);
  });
});
