// Entity conformance · the writes that answer a COUNT: `insertAll(rows, { returning: false })`,
// `upsertAll(rows, { …, returning: false })` and `copyAll(rows)`. Each one is `insertAll` without the
// rows coming back — same defaults, tenancy, sealing and judging, all or nothing, reported and
// recorded in history — so every claim below is asked of all three writers alike.

import { expect } from 'bun:test';
import type { Database } from '@ultimat3/entity';
import { entity, history, text, timestamp, uuid } from '@ultimat3/entity';
import type { DriverCapability } from '@ultimat3/entity/adapter';
import { remember } from './entity-conformance-entities';
import { checkOver, codeOf, idAt, inOrg } from './entity-conformance-support';
import {
  ledger,
  logged,
  loggedHistory,
  posts,
  swept,
  vault,
} from './entity-conformance-write-entities';
import { accountedFor, heard } from './entity-conformance-write-support';
import type { EntityDriverCheck, EntityDriverRun } from './entity-driver-conformance';

/** Every kind of column `$parse` fills: a default, a nullable and a `defaultNow()`. */
const filled = remember(
  entity('ec_nr_filled', {
    columns: {
      id: uuid().primaryKey(),
      code: text({ max: 20 }).unique(),
      title: text({ max: 40 }),
      label: text({ max: 20 }).default('dflt'),
      note: text({ max: 40 }).nullable(),
      createdAt: timestamp().defaultNow(),
    },
  }),
);

/** Primary key only: memory's unique check is a scan per row, and this batch is 40,000 of them. */
const wide = remember(
  entity('ec_nr_wide', {
    columns: { id: text({ max: 20 }).primaryKey(), label: text({ max: 20 }) },
  }),
);

type Batch = readonly Readonly<Record<string, unknown>>[];
interface UpsertCount {
  readonly onConflict: readonly string[];
  readonly onMatch?: 'update' | 'nothing';
  readonly returning: false;
}
/** The three counting writers, row-agnostic: one claim, asked of each over any table. */
interface CountingTable {
  insertAll(rows: Batch, options: { readonly returning: false }): Promise<number>;
  upsertAll(rows: Batch, args: UpsertCount): Promise<number>;
  copyAll(rows: Batch): Promise<number>;
}
const counting = (table: unknown): CountingTable => table as CountingTable;

interface Writer {
  readonly name: string;
  readonly needs: readonly DriverCapability[];
  /** An upsert skips a row its target already holds, so a duplicate TARGET is not its refusal. */
  readonly skipsTarget: boolean;
  write(table: unknown, rows: Batch): Promise<number>;
}

const WRITERS: readonly Writer[] = [
  {
    name: 'insertAll({ returning: false })',
    needs: [],
    skipsTarget: false,
    write: (table, rows) => counting(table).insertAll(rows, { returning: false }),
  },
  {
    name: 'upsertAll({ returning: false })',
    needs: ['upsert'],
    skipsTarget: true,
    write: (table, rows) =>
      counting(table).upsertAll(rows, { onConflict: ['id'], onMatch: 'nothing', returning: false }),
  },
  {
    name: 'copyAll',
    needs: [],
    skipsTarget: false,
    write: (table, rows) => counting(table).copyAll(rows),
  },
];

const [ONE, TWO] = [idAt('e1'), idAt('e2')];
const ORG = idAt('ea');
const OTHER_ORG = idAt('eb');
const WHEN = new Date('2020-01-02T03:04:05.000Z');
const PAST_CEILING = 40_000;

/** One check per writer: the same claim, named for the writer it was asked of. */
const each = <E extends Parameters<typeof checkOver>[0]>(
  entities: E,
  claim: string,
  run: (db: Database<E>, raw: EntityDriverRun, writer: Writer) => Promise<void>,
  only: (writer: Writer) => boolean = () => true,
): readonly EntityDriverCheck[] =>
  WRITERS.filter(only).map((writer) =>
    checkOver(
      entities,
      `${writer.name} ${claim}`,
      (db, raw) => run(db as Database<E>, raw, writer),
      writer.needs,
    ),
  );

const stores: readonly EntityDriverCheck[] = [
  ...each(
    { filled },
    'answers the count and stores every row, defaults filled',
    async (db, _r, w) => {
      const written = await w.write(db.filled, [
        { id: ONE, code: 'a', title: 't' },
        { id: TWO, code: 'b', title: 'u', label: 'set', note: 'n' },
      ]);
      const rows = await db.filled.orderBy('code').all();
      expect([written, rows.map((row) => [row.id, row.label, row.note, row.createdAt])]).toEqual([
        2,
        [
          [ONE, 'dflt', null, new Date()],
          [TWO, 'set', 'n', new Date()],
        ],
      ]);
    },
  ),
  ...each({ filled }, 'writes nothing for an empty batch and answers 0', async (db, _r, w) => {
    expect(await w.write(db.filled, [])).toBe(0);
    expect(await db.filled.count()).toBe(0);
  }),
  ...each(
    { filled },
    'refuses a duplicate unique value whole, in the batch or stored',
    async (db, _r, w) => {
      const inBatch = [
        { id: ONE, code: 'a', title: 't' },
        { id: TWO, code: 'a', title: 'u' },
      ];
      expect(await codeOf(() => w.write(db.filled, inBatch))).toBe('X_DB_UNIQUE_VIOLATION');
      expect(await db.filled.count()).toBe(0);
      await db.filled.insert({ id: ONE, code: 'a', title: 'stored' });
      const clash = [
        { id: idAt('e3'), code: 'b', title: 'fine' },
        { id: TWO, code: 'a', title: 'clash' },
      ];
      expect(await codeOf(() => w.write(db.filled, clash))).toBe('X_DB_UNIQUE_VIOLATION');
      expect((await db.filled.all()).map((row) => row.title)).toEqual(['stored']);
    },
  ),
  ...each(
    { wide },
    'refuses a 40,000-row batch with one duplicate key whole, past the bind ceiling',
    async (db, _r, w) => {
      const batch = Array.from({ length: PAST_CEILING }, (_, index) => ({
        id: `r${index === 35_000 ? 0 : index}`,
        label: 'l',
      }));
      expect(await codeOf(() => w.write(db.wide, batch))).toBe('X_DB_UNIQUE_VIOLATION');
      expect(await db.wide.count()).toBe(0);
    },
    (writer) => !writer.skipsTarget,
  ),
  ...each({ wide }, 'lands a 40,000-row batch whole and counts it', async (db, _r, w) => {
    const batch = Array.from({ length: PAST_CEILING }, (_, index) => ({
      id: `r${index}`,
      label: 'l',
    }));
    expect(await w.write(db.wide, batch)).toBe(PAST_CEILING);
    expect(await db.wide.count()).toBe(PAST_CEILING);
  }),
];

const held = async (db: Database<{ posts: typeof posts }>) =>
  [
    ...(await db.posts.where({ orgId: ORG }).all()),
    ...(await db.posts.where({ orgId: OTHER_ORG }).all()),
  ]
    .map((row) => `${row.orgId === ORG ? 'ours' : 'theirs'}:${row.title}`)
    .sort();

const semantics: readonly EntityDriverCheck[] = [
  ...each(
    { posts },
    'refuses a row in another tenant whole; the actor’s own write',
    async (db, _r, w) => {
      const mixed = [
        { id: ONE, orgId: ORG, title: 'mine' },
        { id: TWO, orgId: OTHER_ORG, title: 'theirs' },
      ];
      expect(await inOrg(ORG, () => codeOf(() => w.write(db.posts, mixed)))).toBe(
        'X_TENANCY_ACTOR_MISMATCH',
      );
      expect(await held(db)).toEqual([]);
      const own = [
        { id: ONE, orgId: ORG, title: 'a' },
        { id: TWO, orgId: ORG, title: 'b' },
      ];
      expect(await inOrg(ORG, () => w.write(db.posts, own))).toBe(2);
      expect(await held(db)).toEqual(['ours:a', 'ours:b']);
    },
  ),
  ...each(
    { swept },
    'judges a JS-only rule on every row and refuses the batch whole',
    async (db, _r, w) => {
      const batch = [
        { id: ONE, kind: 'k', reason: 'fine', deletedAt: null },
        { id: TWO, kind: 'k', reason: null, deletedAt: WHEN },
      ];
      expect(await codeOf(() => w.write(db.swept, batch))).toBe('X_INVARIANT_VIOLATED');
      expect(await db.swept.count()).toBe(0);
    },
  ),
  ...each(
    { vault },
    'seals what it writes: the row reads back plaintext, found by lookup',
    async (db, _r, w) => {
      await w.write(db.vault, [
        { id: ONE, label: 'a', secret: 's1', email: 'a@example.com' },
        { id: TWO, label: 'b', secret: null, email: 'b@example.com' },
      ]);
      const rows = await db.vault.orderBy('id').all();
      expect(rows.map((row) => [row.secret, row.email])).toEqual([
        ['s1', 'a@example.com'],
        [null, 'b@example.com'],
      ]);
      expect((await db.vault.where({ email: 'b@example.com' }).one())?.id).toBe(TWO);
    },
  ),
  ...each(
    { filled },
    'is reported to the row observer for every row it wrote',
    async (db, _r, w) => {
      const { answer, heard: told } = await heard('ec_nr_filled', () =>
        w.write(db.filled, [
          { id: ONE, code: 'a', title: 't' },
          { id: TWO, code: 'b', title: 'u' },
        ]),
      );
      expect([answer, accountedFor(told)]).toEqual([2, 2]);
    },
  ),
  ...each({ logged, loggedHistory }, 'writes one insert version per row', async (db, raw, w) => {
    if (!raw.history) return;
    const versions = await inOrg(ORG, async () => {
      await w.write(db.logged, [
        { id: ONE, orgId: ORG, title: 'a' },
        { id: TWO, orgId: ORG, title: 'b' },
      ]);
      return [await history(db.loggedHistory, ONE), await history(db.loggedHistory, TWO)];
    });
    const title = (image: unknown): string | null =>
      (image as { title?: string } | null)?.title ?? null;
    expect(versions.map((all) => all.map((v) => [v.version, v.op, title(v.after)]))).toEqual([
      [[1, 'insert', 'a']],
      [[1, 'insert', 'b']],
    ]);
  }),
  ...each({ ledger }, 'appends to an append-only table', async (db, _r, w) => {
    expect(await w.write(db.ledger, [{ id: ONE, account: 'cash', note: 'n' }])).toBe(1);
    expect((await db.ledger.all()).map((row) => row.note)).toEqual(['n']);
  }),
];

const STORED = {
  id: ONE,
  code: 'a',
  label: 'kept',
  note: 'kept note',
  title: 'old',
  createdAt: WHEN,
};

const upserts: readonly EntityDriverCheck[] = [
  checkOver(
    { filled },
    'upsertAll({ returning: false }) counts the rows it wrote, overwriting only what was named',
    async (db) => {
      await db.filled.insert(STORED);
      const incoming = [
        { code: 'a', title: 'new' },
        { code: 'c', title: 'fresh' },
      ];
      const skipped: number = await db.filled.upsertAll(incoming, {
        onConflict: ['code'],
        onMatch: 'nothing',
        returning: false,
      });
      expect(skipped).toBe(1);
      expect((await db.filled.where({ code: 'a' }).one())?.title).toBe('old');
      const merged: number = await db.filled.upsertAll(incoming, {
        onConflict: ['code'],
        returning: false,
      });
      expect(merged).toBe(2);
      const rows = await db.filled.orderBy('code').all();
      expect(rows.map((row) => [row.code, row.title, row.label, row.note, row.createdAt])).toEqual([
        ['a', 'new', 'kept', 'kept note', WHEN],
        ['c', 'fresh', 'dflt', null, new Date()],
      ]);
    },
    ['upsert'],
  ),
  checkOver(
    { swept },
    'upsertAll({ returning: false }) judges the merged row: a broken JS-only rule is refused',
    async (db, { driver }) => {
      await db.swept.insert({ id: ONE, kind: 'k', reason: 'because', deletedAt: null });
      await db.swept.delete(ONE);
      const merge = () =>
        db.swept.upsertAll([{ id: ONE, kind: 'k', reason: null }], {
          onConflict: ['id'],
          returning: false,
        });
      expect(await codeOf(merge)).toBe('X_INVARIANT_VIOLATED');
      const { rows } = await driver.repo(swept).findMany({ includeDeleted: true });
      expect(rows.map((row) => [row.reason, row.deletedAt === null])).toEqual([['because', false]]);
    },
    ['upsert'],
  ),
  checkOver(
    { ledger },
    'upsertAll({ returning: false }) on an append-only table is refused when it would update',
    async (db) => {
      await db.ledger.insert({ id: ONE, account: 'cash', note: 'n' });
      const rewrite = () =>
        db.ledger.upsertAll([{ id: ONE, account: 'cash', note: 'x' }], {
          onConflict: ['id'],
          returning: false,
        });
      expect(await codeOf(rewrite)).toBe('X_ENTITY_APPEND_ONLY');
      expect((await db.ledger.all()).map((row) => row.note)).toEqual(['n']);
    },
    ['upsert'],
  ),
  checkOver(
    { filled },
    'copyAll and insertAll({ returning: false }) answer a number, never rows',
    async (db) => {
      const inserted: number = await db.filled.insertAll([{ code: 'a', title: 't' }], {
        returning: false,
      });
      const copied: number = await db.filled.copyAll([{ code: 'b', title: 'u' }]);
      expect([inserted, copied, await db.filled.count()]).toEqual([1, 1, 2]);
    },
  ),
];

export const UNRETURNED_CHECKS: readonly EntityDriverCheck[] = [
  ...stores,
  ...semantics,
  ...upserts,
];
