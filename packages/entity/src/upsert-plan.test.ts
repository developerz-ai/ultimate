// Single responsibility: which batches an `upsertAll` refuses before any SQL exists, what a
// collision overwrites when it does not, and the key that collision is judged on. The sibling
// `bulk-write.test.ts` covers what one statement carries — the column list and the bind-count
// chunking — and both read the same `bulk-write.ts`, so a rule missing from either is a rule the
// two drivers are free to disagree about.

import { afterAll, describe, expect, test } from 'bun:test';
import { keyOf } from './batch-read';
import { conflictKeyOf, conflictKeys, upsertPlan } from './bulk-write';
import { integer, money, text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { EntityError } from './errors';
import { invariant } from './invariants';
import { clearRegistry } from './registry';

const items = entity('upsert_items', {
  columns: {
    id: uuid().primaryKey(),
    sku: text().unique(),
    serial: text().nullable().unique(),
    label: text(),
    unitPrice: money(),
    quantity: integer(),
  },
});

/** A composite key: "the plan drops every primary key property" has to mean more than one. */
const marks = entity('upsert_marks', {
  columns: { postId: uuid(), memberId: uuid(), rank: integer(), note: text().unique() },
  primaryKey: ['postId', 'memberId'],
});

/** A tenant column and a partial unique index — the two refusals that need a schema to exist. */
const drafts = entity('upsert_drafts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    slug: text(),
    title: text(),
    deletedAt: timestamp().nullable(),
  },
  indexes: [
    { on: ['orgId', 'slug'], unique: true },
    // A partial unique index has to have its predicate repeated in the `on conflict` clause, and
    // a bare column list cannot say it — so this is a constraint no conflict target can name.
    { on: ['title'], unique: true, where: (c) => c.title.minLength(1) },
  ],
  // `bindInvariant` stamps `deleted_at is null` onto a unique invariant of a soft-deleting entity,
  // so this one is partial too — the same exclusion, reached down the other declaration path.
  invariants: (c) => [invariant('upsert_draft_slug', c.unique(['slug']))],
});

/**
 * The third spelling of one unique index: `invariant(name, c.unique([…]))` emits its
 * `create unique index` out of `$invariants` and never touches `$indexes`. Refusing it would tell
 * the author to declare a constraint they already declared — and then ship two of them.
 */
const tickets = entity('upsert_tickets', {
  columns: { id: uuid().primaryKey(), queue: text(), slot: integer(), note: text() },
  invariants: (c) => [invariant('upsert_ticket_slot', c.unique(['queue', 'slot']))],
});

const ID = '0192f5a0-0000-7000-8000-00000000000a';
const ORG = '0192f5a0-0000-7000-8000-0000000000b0';

const item = { id: ID, sku: 'a', label: 'l', quantity: 1 };
const mark = { postId: ID, memberId: ORG, rank: 1, note: 'n' };
const draft = { id: ID, orgId: ORG, slug: 'first', title: 'First', deletedAt: null };
/** The same row with no stamp named at all — what a batch assembled by hand carries. */
const live = { id: ID, orgId: ORG, slug: 'first', title: 'First' };

/** `toBeUltimateError` reads a value, and every refusal here throws synchronously. */
const caught = (run: () => unknown): EntityError | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof EntityError ? error : undefined;
  }
  return undefined;
};

afterAll(() => {
  clearRegistry();
});

describe('the constraint a collision is judged against', () => {
  test('the primary key and a unique() column are both targets a duplicate can land on', () => {
    expect(upsertPlan(items, [item], ['id'], 'nothing')).toEqual({ on: ['id'], set: [] });
    expect(upsertPlan(items, [item], ['sku'], 'nothing')).toEqual({ on: ['sku'], set: [] });
    // Compared as a SET of physical columns, so a composite key named in either order is the
    // same constraint — an `on conflict` clause is not ordered either.
    expect(upsertPlan(marks, [mark], ['memberId', 'postId'], 'nothing')).toEqual({
      on: ['memberId', 'postId'],
      set: [],
    });
  });

  test('a target no unique constraint matches is refused before a statement exists', () => {
    // Postgres answers `on conflict (label)` with 42P10 — "there is no unique or exclusion
    // constraint matching the ON CONFLICT specification" — whatever the rest of the batch says.
    const error = caught(() => upsertPlan(items, [item], ['label'], 'update'));
    expect(error).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(error?.cause).toContain('declares no unique constraint on (label)');
    expect(error?.cause).toContain('42P10');
    expect(error?.fix).toContain("indexes: [{ on: ['label'], unique: true }]");
  });

  test('two columns are not a constraint just because each of them is a column', () => {
    // `(sku)` is unique and `(id)` is the key, and neither makes `(sku, label)` an index.
    expect(caught(() => upsertPlan(items, [item], ['sku', 'label'], 'update'))).toBeUltimateError(
      'X_INVARIANT_VIOLATED',
    );
    expect(caught(() => upsertPlan(marks, [mark], ['postId'], 'nothing'))).toBeUltimateError(
      'X_INVARIANT_VIOLATED',
    );
    // Money is two physical columns and no index covers the pair, so it is refused here rather
    // than reaching a driver that would have to guess which half the conflict is on.
    expect(caught(() => upsertPlan(items, [item], ['unitPrice'], 'nothing'))).toBeUltimateError(
      'X_INVARIANT_VIOLATED',
    );
  });

  test('a partial unique index is not a target a bare column list can name', () => {
    const error = caught(() => upsertPlan(drafts, [draft], ['title'], 'nothing'));
    expect(error).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(error?.cause).toContain('42P10');
    // The list of what it does have is the proof the partial one was left out of it — and `slug`
    // is the invariant-declared one, partial for the same reason, so both paths are covered.
    expect(error?.cause).toContain('it has (id); (org_id, slug)');
    expect(caught(() => upsertPlan(drafts, [draft], ['slug'], 'nothing'))).toBeUltimateError(
      'X_INVARIANT_VIOLATED',
    );
    expect(upsertPlan(drafts, [draft], ['orgId', 'slug'], 'nothing')).toEqual({
      on: ['orgId', 'slug'],
      set: [],
    });
  });

  test('a unique() invariant is a constraint too — this framework declares one three ways', () => {
    const ticket = { id: ID, queue: 'inbound', slot: 3, note: 'first' };
    // Refusing it would send the author to add `indexes: [{ on: ['queue','slot'], unique: true }]`
    // beside the invariant that already emits that exact index — two declarations, two indexes.
    expect(upsertPlan(tickets, [ticket], ['queue', 'slot'], 'update')).toEqual({
      on: ['queue', 'slot'],
      set: ['note'],
    });
    expect(
      caught(() => upsertPlan(tickets, [ticket], ['queue', 'note'], 'nothing')),
    ).toBeUltimateError('X_INVARIANT_VIOLATED');
  });

  test('a batch with no conflict target is refused — "any constraint" is not a target', () => {
    const error = caught(() => upsertPlan(items, [item], [], 'update'));
    expect(error).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(error?.cause).toContain('named no onConflict columns');
    expect(error?.fix).toContain("onConflict: ['<column>']");
  });

  test('a conflict target the entity never declared is refused, and the columns are listed', () => {
    for (const onMatch of ['update', 'nothing'] as const) {
      const error = caught(() => upsertPlan(items, [item], ['nope'], onMatch));
      expect(error).toBeUltimateError('X_INVARIANT_VIOLATED');
      expect(error?.cause).toContain('no column "nope"');
      expect(error?.cause).toContain('sku');
      expect(error?.cause).toContain('unitPrice');
    }
  });
});

describe('what a collision overwrites', () => {
  test('update takes the batch minus the conflict target and minus the primary key', () => {
    expect(upsertPlan(items, [item], ['sku'], 'update')).toEqual({
      on: ['sku'],
      set: ['label', 'quantity'],
    });
  });

  test('every primary key property goes, even when none of them is the conflict target', () => {
    // The address is the closed set the upsert must not move: a composite key is two properties,
    // and dropping only the one named in `onConflict` would leave the other writable.
    expect(upsertPlan(marks, [mark], ['note'], 'update')).toEqual({ on: ['note'], set: ['rank'] });
  });

  test('nothing overwrites nothing, however much the batch names', () => {
    expect(upsertPlan(items, [item], ['sku'], 'nothing')).toEqual({ on: ['sku'], set: [] });
  });

  test('an update that would write nothing is refused, and the fix names the other mode', () => {
    // Every column in the batch is the conflict target or the key, so `do update` would set
    // nothing — Postgres accepts that statement and the caller learns nothing changed from a row
    // count they never see.
    const error = caught(() => upsertPlan(items, [{ id: ID, sku: 'a' }], ['sku'], 'update'));
    expect(error).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(error?.cause).toContain('would write nothing on a collision');
    expect(error?.fix).toContain("onMatch: 'nothing'");
  });

  test('an empty batch has nothing to refuse, but its conflict target is still checked', () => {
    expect(upsertPlan(items, [], ['sku'], 'update')).toEqual({ on: ['sku'], set: [] });
    // A typo in `onConflict`, or a target no index matches, fails on no rows exactly as it does
    // on a page — the target is a fact about the schema, not about the batch.
    for (const target of [[], ['nope'], ['label']]) {
      expect(caught(() => upsertPlan(items, [], target, 'update'))).toBeUltimateError(
        'X_INVARIANT_VIOLATED',
      );
    }
  });
});

describe('the tenant column an updating upsert has to carry', () => {
  test('a target that skips it is refused: the collision would land on another tenant', () => {
    const error = caught(() => upsertPlan(drafts, [draft], ['id'], 'update'));
    expect(error).toBeUltimateError('X_TENANCY_UNSCOPED');
    expect(error?.cause).toContain('"orgId"');
    expect(error?.fix).toContain("onConflict: ['orgId', 'id']");
  });

  test('nothing writes nothing to a row it does not own, so the same target is allowed', () => {
    expect(upsertPlan(drafts, [draft], ['id'], 'nothing')).toEqual({ on: ['id'], set: [] });
  });

  test('a target carrying the tenant column is the one that resolves a collision', () => {
    expect(upsertPlan(drafts, [live], ['orgId', 'slug'], 'update')).toEqual({
      on: ['orgId', 'slug'],
      set: ['title'],
    });
  });
});

describe('the soft-delete stamp an updating upsert never writes', () => {
  test('a batch naming it still does not set it: the collision would bring a deleted row back', () => {
    // A stamped row still occupies its conflict target — the index it collides with is not partial
    // — so `excluded."deleted_at"` would clear a stamp the app wrote. `update(id, patch)` and
    // `updateWhere` refuse the same resurrection by carrying `deleted_at is null`, which an
    // `on conflict` clause cannot carry.
    expect(upsertPlan(drafts, [draft], ['orgId', 'slug'], 'update')).toEqual({
      on: ['orgId', 'slug'],
      set: ['title'],
    });
  });

  test('excluded, not refused: `$parse` writes that null, so refusing it would refuse every row', () => {
    // Every declared column is present by the time a row reaches the plan, stamp included — the
    // `deletedAt: null` is the framework's, not the caller's.
    expect(
      upsertPlan(drafts, [{ ...live, deletedAt: undefined }], ['orgId', 'slug'], 'update').set,
    ).toEqual(['title']);
  });

  test('a batch of nothing but the stamp writes nothing, and says which columns are spared', () => {
    const error = caught(() =>
      upsertPlan(
        drafts,
        [{ orgId: ORG, slug: 'first', deletedAt: null }],
        ['orgId', 'slug'],
        'update',
      ),
    );
    expect(error).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(error?.cause).toContain('deletedAt');
  });

  test('an entity with no soft-delete column has no such stamp to spare', () => {
    // `deletedAt` is only a stamp where the entity declares one: elsewhere it is an ordinary
    // column, and sparing it would be a rule read off a property name.
    expect(upsertPlan(items, [{ ...item, deletedAt: null }], ['sku'], 'update').set).toEqual([
      'label',
      'quantity',
    ]);
  });
});

describe('the rows of an updating batch name the same columns', () => {
  const uneven = [{ sku: 'a', label: 'x' }, { sku: 'b' }];

  test('a row that omits a column the batch writes is refused, naming both', () => {
    // `excluded.<col>` for a row that omitted the column is that column's DEFAULT, not "leave the
    // stored value alone" — so an uneven batch overwrites with a default nobody asked for.
    const error = caught(() => upsertPlan(items, uneven, ['sku'], 'update'));
    expect(error).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(error?.cause).toContain('row 2');
    expect(error?.cause).toContain('"label"');
    expect(error?.fix).toContain('label: <value>');
  });

  test('naming it and leaving it undefined is naming it — the same Object.hasOwn', () => {
    const even = [
      { sku: 'a', label: undefined },
      { sku: 'b', label: 'y' },
    ] as Partial<Item>[];
    expect(upsertPlan(items, even, ['sku'], 'update')).toEqual({ on: ['sku'], set: ['label'] });
  });

  test('an uneven batch under nothing is allowed — there is nothing to overwrite', () => {
    expect(upsertPlan(items, uneven, ['sku'], 'nothing')).toEqual({ on: ['sku'], set: [] });
  });
});

describe('the key a collision is judged on', () => {
  test('a uuid is spelled the way a batched read spells it — case-insensitively', () => {
    // Postgres compares a uuid as a value and prints it lower-cased, so an id handed in upper case
    // matches the stored row there and would miss it here.
    expect(conflictKeyOf(items, ['id'], { id: ID.toUpperCase() })).toBe(
      conflictKeyOf(items, ['id'], { id: ID }),
    );
    expect(conflictKeyOf(items, ['id'], { id: ID.toUpperCase() })).toContain(keyOf('uuid', ID));
  });

  test('every other kind is byte-exact — lower-casing merges rows Postgres separates', () => {
    expect(conflictKeyOf(items, ['sku'], { sku: 'Bob' })).not.toBe(
      conflictKeyOf(items, ['sku'], { sku: 'bob' }),
    );
    expect(conflictKeyOf(items, ['quantity'], { quantity: 1 })).not.toBe(
      conflictKeyOf(items, ['quantity'], { quantity: 11 }),
    );
  });

  test('a cell is spelled by its type, never by String()', () => {
    // `String(date)` drops the milliseconds and `String(money)` is "[object Object]" — either one
    // files two rows Postgres keeps apart under a single key.
    const at = (ms: string): Date => new Date(`2026-03-04T05:06:07.${ms}Z`);
    expect(conflictKeyOf(drafts, ['deletedAt'], { deletedAt: at('001') })).not.toBe(
      conflictKeyOf(drafts, ['deletedAt'], { deletedAt: at('002') }),
    );
    const priced = (minor: bigint): Partial<Item> => ({ unitPrice: { minor, currency: 'EUR' } });
    expect(conflictKeyOf(items, ['unitPrice'], priced(1n))).not.toBe(
      conflictKeyOf(items, ['unitPrice'], priced(2n)),
    );
    expect(conflictKeyOf(items, ['unitPrice'], priced(1n))).toBe(
      conflictKeyOf(items, ['unitPrice'], priced(1n)),
    );
  });

  test('a null in the target is no key at all — a default unique index is NULLS DISTINCT', () => {
    expect(conflictKeyOf(items, ['serial'], { serial: null })).toBeUndefined();
    // Every other cell being present does not save it: the index compares no null to anything.
    expect(conflictKeyOf(marks, ['postId', 'memberId'], { postId: ID, memberId: null })).toBe(
      undefined,
    );
    expect(conflictKeyOf(items, ['serial'], { serial: 'S-1' })).not.toBeUndefined();
  });

  test('a composite target cannot have its boundary forged by a value carrying one', () => {
    // A joined string would spell ('a','b') and ('ab','') identically, and one row would then
    // collide with a row Postgres treats as a different one. JSON is why it cannot.
    const parts = conflictKeyOf(marks, ['postId', 'memberId'], { postId: 'a', memberId: 'b' });
    expect(parts).not.toBe(
      conflictKeyOf(marks, ['postId', 'memberId'], { postId: 'ab', memberId: '' }),
    );
    expect(parts).not.toBe(
      conflictKeyOf(marks, ['memberId', 'postId'], { postId: 'a', memberId: 'b' }),
    );
  });

  test('one key per row, in the order the batch gave them', () => {
    const rows = [
      { sku: 'a', label: 'x' },
      { sku: 'b', label: 'y' },
      { sku: 'c', label: 'z' },
    ];
    const keys = conflictKeys(items, upsertPlan(items, rows, ['sku'], 'update'), rows);
    expect(keys).toHaveLength(3);
    expect(keys).toEqual(rows.map((row) => conflictKeyOf(items, ['sku'], row)));
  });

  test('a batch that collides with itself under update is refused, naming the row', () => {
    // Postgres answers this with 21000, "ON CONFLICT DO UPDATE command cannot affect row a second
    // time" — refused in both drivers rather than passing in memory and failing in production.
    const rows = [
      { sku: 'a', label: 'x' },
      { sku: 'b', label: 'y' },
      { sku: 'a', label: 'z' },
    ];
    const plan = upsertPlan(items, rows, ['sku'], 'update');
    const error = caught(() => conflictKeys(items, plan, rows));
    expect(error).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(error?.cause).toContain('row 3');
    expect(error?.cause).toContain('sku');
    expect(error?.fix).toContain("onMatch: 'nothing'");
  });

  test('the repeat is judged on the key, so two spellings of one uuid are one row', () => {
    const rows = [
      { id: ID, label: 'x' },
      { id: ID.toUpperCase(), label: 'y' },
    ];
    const plan = upsertPlan(items, rows, ['id'], 'update');
    expect(caught(() => conflictKeys(items, plan, rows))).toBeUltimateError('X_INVARIANT_VIOLATED');
  });

  test('two null keys are not a repeat — they are two rows that collide with nothing', () => {
    const rows = [
      { serial: null, label: 'x' },
      { serial: null, label: 'y' },
    ];
    const plan = upsertPlan(items, rows, ['serial'], 'update');
    expect(plan.set).toEqual(['label']);
    expect(conflictKeys(items, plan, rows)).toEqual([undefined, undefined]);
  });

  test('under nothing the server skips the repeat, so the repeat is kept', () => {
    const rows = [{ sku: 'a' }, { sku: 'a' }];
    const keys = conflictKeys(items, upsertPlan(items, rows, ['sku'], 'nothing'), rows);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1] ?? '');
  });
});
