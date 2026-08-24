// Many rows, ONE statement. `insertAll`/`upsertAll` against a recording client, where the statement
// text is the whole claim: the tuple list, the `default` cell a row naming fewer columns takes, the
// `on conflict` clause each `onMatch` compiles to and the four refusals that precede it, and the
// chunking that keeps a wide batch inside Postgres's bind count.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createContext, isUltimateError, runWithContext, userActor } from '@ultimat3/core';
import { createRecordingClient, type RecordingClient, setDbClient } from '@ultimat3/db';
import { MAX_BIND_PARAMETERS } from './bulk-write';
import { boolean, money, text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { postgresRepo } from './pg-driver';
import { allColumns } from './pg-row';
import { clearRegistry } from './registry';
import type { UpsertArgs } from './repo';

const orgs = entity('pg_bulk_orgs', {
  columns: { id: uuid().primaryKey(), slug: text({ max: 40 }).unique() },
});

/**
 * Two unique constraints, since an upsert may only target one that exists: `reference` alone, which
 * a tenant-scoped entity can only resolve with `'nothing'`, and `(orgId, reference)`, which carries
 * the tenant column and is therefore the only target `'update'` accepts here.
 */
const invoices = entity('pg_bulk_invoices', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    reference: text({ max: 40 }).unique(),
    total: money(),
    paid: boolean().default(false),
    note: text().nullable(),
    issuedAt: timestamp().defaultNow(),
    deletedAt: timestamp().nullable(),
  },
  indexes: [{ on: ['orgId', 'reference'], unique: true }],
});

/**
 * A composite primary key — the other kind of unique index an upsert lands on. A batch naming only
 * the three key columns is the shape `'update'` has nothing to write on: target and key are both
 * excluded from the set list by construction.
 */
const likes = entity('pg_bulk_likes', {
  columns: {
    orgId: uuid().tenant(),
    postId: uuid(),
    memberId: uuid(),
    createdAt: timestamp().defaultNow(),
  },
  primaryKey: ['orgId', 'postId', 'memberId'],
});

type Invoice = typeof invoices.$row;
type Like = typeof likes.$row;

const idAt = (index: number): string =>
  `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`;

const ORG = idAt(1);
const STAMPED = new Date('2026-01-02T03:04:05.000Z');

const ROW: Invoice = {
  id: idAt(101),
  orgId: ORG,
  reference: 'INV-101',
  total: { minor: 129900, currency: 'EUR' },
  paid: false,
  note: null,
  issuedAt: STAMPED,
  deletedAt: null,
};

const invoice = (index: number, over: Partial<Invoice> = {}): Invoice => ({
  ...ROW,
  id: idAt(index),
  reference: `INV-${index}`,
  ...over,
});

/** A row leaving columns out — a `default` cell. `Repo` is typed for whole rows, hence the cast. */
const partial = (values: Partial<Invoice>): Invoice => values as Invoice;

/** One row in three spellings: the physical column, the value bound, what Bun.SQL hands back. */
const cellsOf = (row: Invoice): readonly (readonly [string, unknown, unknown])[] => [
  ['id', row.id, row.id],
  ['org_id', row.orgId, row.orgId],
  ['reference', row.reference, row.reference],
  ['total_minor', row.total.minor, String(row.total.minor)],
  ['total_currency', row.total.currency, row.total.currency],
  // The third money column: `null` is "the currency's own minor unit", which is every row here.
  ['total_scale', row.total.scale ?? null, row.total.scale ?? null],
  ['paid', row.paid, row.paid],
  ['note', row.note, row.note],
  ['issued_at', row.issuedAt, row.issuedAt.toISOString()],
  ['deleted_at', row.deletedAt, row.deletedAt?.toISOString() ?? null],
];

const physicalOf = (row: Invoice): Record<string, unknown> =>
  Object.fromEntries(cellsOf(row).map(([column, , stored]) => [column, stored]));
const COLUMNS = `(${cellsOf(ROW)
  .map(([column]) => `"${column}"`)
  .join(', ')})`;

let client: RecordingClient;

beforeEach(() => {
  client = createRecordingClient();
  setDbClient(client);
});

afterAll(() => {
  setDbClient(undefined);
  clearRegistry();
});

const repo = () => postgresRepo(invoices);
const lastText = (): string => client.texts.at(-1) ?? '';
const lastValues = (): readonly unknown[] => client.statements.at(-1)?.values ?? [];
const tuplesOf = (text: string): readonly string[] => text.split('), (');

/** An `onConflict` `keyof Row & string` refuses; a JS caller reaches the runtime guard for free. */
const targeting = (...onConflict: string[]): UpsertArgs<Invoice> =>
  ({ onConflict }) as UpsertArgs<Invoice>;

type Refusal = Record<'code' | 'cause' | 'fix', string>;

/** What a refusal says. A code is the contract, and a `fix:` that names no edit is not one. */
const refusal = async (call: Promise<unknown>): Promise<Refusal> => {
  try {
    await call;
    return { code: 'resolved', cause: '', fix: '' };
  } catch (error) {
    if (!isUltimateError(error)) return { code: String(error), cause: '', fix: '' };
    return { code: error.code, cause: error.cause, fix: error.fix };
  }
};

describe('a batch is one statement, and both drivers mean the same by it', () => {
  test('three rows are one statement; the same three, one at a time, are three', async () => {
    const batch = [invoice(2), invoice(3), invoice(4)];
    client.on('insert into', { rows: batch.map((row) => physicalOf(row)) });

    const written = await repo().insertAll(batch);

    expect(client.statements).toHaveLength(1);
    expect(lastText()).toStartWith(`insert into "pg_bulk_invoices" ${COLUMNS} values (`);
    expect(tuplesOf(lastText())).toHaveLength(3);
    expect(lastText()).toEndWith('returning *');
    expect(lastValues()).toEqual(batch.flatMap((row) => cellsOf(row).map(([, bind]) => bind)));
    expect(written).toEqual(batch);

    // The N+1 this call removes: the loop it replaces is one statement per row.
    for (const row of batch) await repo().insert(row);
    expect(client.statements).toHaveLength(4);
  });

  test('every value is bound, never spliced into the text', async () => {
    const evil = "x'; drop table pg_bulk_invoices; --";
    await repo().insertAll([invoice(2), invoice(3, { reference: evil })]);

    expect(lastText()).not.toContain('drop table');
    expect(lastText()).toEndWith('($11, $12, $13, $14, $15, $16, $17, $18, $19, $20) returning *');
    expect(lastValues()[12]).toBe(evil);
  });

  test('money binds as three parameters, in the positions its three columns occupy', async () => {
    await repo().insertAll([
      invoice(2),
      invoice(3, { total: { minor: 5, currency: 'USD', scale: 6 } }),
    ]);

    expect(lastText()).toContain('"total_minor", "total_currency", "total_scale"');
    // An amount at the currency's own scale binds `null` there — never `0`, which means whole
    // units and would reinterpret every ordinary price by a factor of a hundred.
    expect(lastValues().slice(3, 6)).toEqual([129900, 'EUR', null]);
    expect(lastValues().slice(13, 16)).toEqual([5, 'USD', 6]);
  });

  test('no rows is no statement, and one row is the statement insert always sent', async () => {
    expect(await repo().insertAll([])).toEqual([]);
    expect(client.statements).toHaveLength(0);

    client.on('insert into', { rows: [physicalOf(ROW)] });
    await repo().insert(ROW);
    const alone = client.statements.at(-1);
    await repo().insertAll([ROW]);

    expect(client.statements.at(-1)?.text).toBe(alone?.text ?? '');
    expect(client.statements.at(-1)?.values).toEqual(alone?.values ?? []);
  });

  test('a row that names fewer columns takes the column default in its cell', async () => {
    const sparse = partial({ orgId: ORG, reference: 'INV-3', total: ROW.total });
    await repo().insertAll([invoice(2), sparse]);

    // One column list for the statement, so the row naming three of them says `default` for the
    // rest — which is what makes a row inside a batch mean what it means on its own.
    expect(tuplesOf(lastText())[0]).not.toContain('default');
    expect(lastText()).toContain(
      '(default, $11, $12, $13, $14, $15, default, default, default, default)',
    );
    expect(lastValues()).toHaveLength(15);
  });

  test('past the bind count it is whole statements whose tuples are the batch, in order', async () => {
    // Computed, never a magic number: the limit is Postgres's and the width is this entity's.
    const width = allColumns(invoices).length;
    const perStatement = Math.floor(MAX_BIND_PARAMETERS / width);
    const batch = Array.from({ length: perStatement + 2 }, (_, index) => invoice(index + 1000));

    await repo().insertAll(batch);

    expect(client.statements).toHaveLength(2);
    expect(client.statements[0]?.values).toHaveLength(perStatement * width);
    expect(client.statements[1]?.values).toHaveLength(2 * width);
    // Each one is a whole statement, never a fragment of one Postgres would refuse.
    for (const statement of client.statements) {
      expect(statement.text).toStartWith(`insert into "pg_bulk_invoices" ${COLUMNS} values (`);
      expect(statement.text).toEndWith('returning *');
    }
    // The references, in the order the batch named them: nothing dropped, nothing reordered.
    const bound = client.statements.flatMap((statement) => [...statement.values]);
    expect(bound.filter((_, index) => index % width === 2)).toEqual(
      batch.map((row) => row.reference),
    );
  });

  test('decodes, and reports what it wrote, exactly as the in-memory driver does', async () => {
    const plain = [invoice(2), invoice(3)];
    client.on('insert into', { rows: plain.map((row) => physicalOf(row)) });
    expect(await repo().insertAll(plain)).toEqual(await memoryRepo(invoices).insertAll(plain));

    const stored = invoice(2);
    const colliding = [invoice(4, { reference: stored.reference }), invoice(3)];
    // `returning *` names only the rows the server inserted: the collision is not one of them.
    client.on('insert into', { rows: [physicalOf(invoice(3))] });
    const args = { onConflict: ['reference'] as const, onMatch: 'nothing' as const };

    const written = await repo().upsertAll(colliding, args);

    expect(written).toEqual(await memoryRepo(invoices, [stored]).upsertAll(colliding, args));
    expect(written.map((row) => row.reference)).toEqual(['INV-3']);
  });
});

describe('upsertAll() compiles the conflict clause', () => {
  const batch = [invoice(2), invoice(3)];

  test('the two onMatch modes are do nothing and a set list that spares key and target', async () => {
    await repo().upsertAll(batch, { onConflict: ['reference'], onMatch: 'nothing' });
    expect(lastText()).toEndWith(' on conflict ("reference") do nothing returning *');

    await repo().upsertAll(batch, { onConflict: ['orgId', 'reference'] });
    expect(lastText()).toEndWith(
      ' on conflict ("org_id", "reference") do update set' +
        ' "total_minor" = excluded."total_minor", "total_currency" = excluded."total_currency",' +
        ' "total_scale" = excluded."total_scale",' +
        ' "paid" = excluded."paid", "note" = excluded."note", "issued_at" = excluded."issued_at"' +
        ' returning *',
    );
    // Neither `"id"` nor `"reference"` is in that list: how the row was found and where it lives.
    // `"org_id"` is absent too, because the tenant column is part of the target now — so the
    // statement can only land on a row of the tenant that sent it, and this is the assertion that
    // stops a cross-tenant rewrite coming back as a set-list entry.
    expect(lastText()).not.toContain('excluded."org_id"');
    // And `"deleted_at"` is the third: a soft-deleted row still occupies its conflict target, so
    // setting the stamp from `excluded` would clear a delete the app made and hand the row back.
    // The column is still in the INSERT list above — a row that collides with nothing keeps it.
    expect(lastText()).not.toContain('excluded."deleted_at"');
    expect(lastText()).toContain('"deleted_at") values');
  });

  test('a collision leaves the stamp where it was, in both drivers', async () => {
    // The rule lives in `bulk-write.ts`, so the in-memory driver reads the same answer rather than
    // a second copy of it: the stored row stays deleted and takes the batch's other columns.
    const deleted = invoice(2, { deletedAt: STAMPED, note: 'gone' });
    const incoming = invoice(2, { note: 'back?' });
    const args = { onConflict: ['orgId', 'reference'] as const };

    const [merged] = await memoryRepo(invoices, [deleted]).upsertAll([incoming], args);

    expect(merged?.deletedAt).toEqual(STAMPED);
    expect(merged?.note).toBe('back?');
  });

  test('a composite conflict target names every column of the index, and sets none of them', async () => {
    // The entity's own composite primary key — a constraint that exists, which is the only kind
    // there is: an arbitrary pair of columns is `42P10`, with no index to match it.
    const like = { orgId: ORG, postId: idAt(7), memberId: idAt(8), createdAt: STAMPED };
    await postgresRepo(likes).upsertAll([like], { onConflict: ['orgId', 'postId', 'memberId'] });

    expect(lastText()).toEndWith(
      ' on conflict ("org_id", "post_id", "member_id")' +
        ' do update set "created_at" = excluded."created_at" returning *',
    );
  });

  test('a batch repeating a conflict target is refused under update, allowed under nothing', async () => {
    const twice = [invoice(2), invoice(3, { reference: 'INV-2' })];
    const args = { onConflict: ['orgId', 'reference'] as const };

    expect((await refusal(repo().upsertAll(twice, args))).code).toBe('X_INVARIANT_VIOLATED');
    expect(client.statements).toHaveLength(0);

    // `do nothing` skips the repeat on the server, so there is nothing here to refuse.
    await repo().upsertAll(twice, { ...args, onMatch: 'nothing' });
    expect(client.statements).toHaveLength(1);
  });

  test('a target no declared unique constraint matches is refused, naming 42P10', async () => {
    // Two ordinary columns: Postgres can infer no index for them, and the refusal has to name the
    // declaration that would make the target real — `42P10` alone names nothing to edit.
    const refused = await refusal(repo().upsertAll([ROW], targeting('reference', 'note')));

    expect(refused.code).toBe('X_INVARIANT_VIOLATED');
    expect(refused.cause).toContain('42P10');
    expect(refused.cause).toContain('(org_id, reference)');
    expect(refused.fix).toContain("indexes: [{ on: ['reference', 'note'], unique: true }]");
    expect(client.statements).toHaveLength(0);
  });

  test('an updating target that misses the tenant column is refused; nothing is not', async () => {
    // `reference` is genuinely unique, so this is not a bad target — it is one that matches another
    // tenant's row. Nothing else scopes the statement: `upsertAll` builds no read plan, and
    // `on conflict … do update` carries no `where`.
    const refused = await refusal(repo().upsertAll(batch, { onConflict: ['reference'] }));

    expect(refused.code).toBe('X_TENANCY_UNSCOPED');
    expect(refused.cause).toContain(
      'a row stored by another tenant would match and be overwritten',
    );
    expect(refused.fix).toContain("onConflict: ['orgId', 'reference']");
    expect(client.statements).toHaveLength(0);

    // `do nothing` writes nothing to a row it does not own, so the same target is legal there.
    await repo().upsertAll(batch, { onConflict: ['reference'], onMatch: 'nothing' });
    expect(client.statements).toHaveLength(1);
  });

  test('an uneven batch is refused under update, and keeps its default cell under nothing', async () => {
    const uneven = [invoice(2), partial({ orgId: ORG, reference: 'INV-3', total: ROW.total })];
    const args = { onConflict: ['orgId', 'reference'] as const };

    // Why it cannot be waved through: `excluded."id"` for the row that omitted `id` is that
    // column's default, so "leave the stored value alone" is not what the server would do.
    const refused = await refusal(repo().upsertAll(uneven, args));
    expect(refused.code).toBe('X_INVARIANT_VIOLATED');
    expect(refused.cause).toContain('does not name "id"');
    expect(client.statements).toHaveLength(0);

    // `do nothing` overwrites nothing, so the cell means what it means in a plain `insertAll`.
    await repo().upsertAll(uneven, { ...args, onMatch: 'nothing' });
    expect(lastText()).toContain(
      '(default, $11, $12, $13, $14, $15, default, default, default, default)',
    );
  });

  test('an empty target, an undeclared column and nothing-to-set each refuse before any statement', async () => {
    // Only the key columns, so nothing this batch names is outside the address `'update'` may not
    // move — and a statement overwriting nothing would report rows it had not written.
    const keyOnly = { orgId: ORG, postId: idAt(7), memberId: idAt(8) } as Like;
    const target = { onConflict: ['orgId', 'postId', 'memberId'] as const };

    const empty = await refusal(repo().upsertAll([ROW], targeting()));
    expect(empty.code).toBe('X_INVARIANT_VIOLATED');
    expect(empty.fix).toContain("pg_bulk_invoices.upsertAll(rows, { onConflict: ['<column>'] })");

    const undeclared = await refusal(repo().upsertAll([ROW], targeting('secret')));
    expect(undeclared.code).toBe('X_INVARIANT_VIOLATED');
    expect(undeclared.fix).toContain('x entities describe pg_bulk_invoices');

    const nothingToSet = await refusal(postgresRepo(likes).upsertAll([keyOnly], target));
    expect(nothingToSet.code).toBe('X_INVARIANT_VIOLATED');
    expect(nothingToSet.fix).toContain("onMatch: 'nothing'");

    expect(client.statements).toHaveLength(0);
  });
});

describe('a bulk write drops what the request preloaded', () => {
  const newOrg = [{ id: idAt(9), slug: 'new' }];

  /**
   * A page of invoices leaves its `orgId` values behind, so the lookup after it costs one widened
   * statement. The write in the middle is the only variable: one to `pg_bulk_orgs` goes through
   * `writing()`, which drops those rows first, so the second lookup reads again.
   */
  const pageLookupWriteLookup = async (write: () => Promise<unknown>): Promise<number> => {
    // Self-contained, so two of these in one test each count their own statements.
    client.reset();
    client.on('from "pg_bulk_invoices"', {
      rows: [physicalOf(invoice(2)), physicalOf(invoice(3))],
    });
    client.on('from "pg_bulk_orgs"', { rows: [{ id: ORG, slug: 'acme' }] });
    client.on('insert into "pg_bulk_orgs"', { rows: newOrg });
    await runWithContext(
      createContext({ actor: userActor({ id: idAt(90), orgId: ORG }) }),
      async () => {
        await repo().findMany({ orgId: ORG, limit: 2 });
        await postgresRepo(orgs).findById(ORG);
        await write();
        await postgresRepo(orgs).findById(ORG);
      },
    );
    return client.statements.length;
  };

  test('insertAll and upsertAll both re-read the row a page had already resolved', async () => {
    // Page, preload, write, and the read the write forced.
    expect(await pageLookupWriteLookup(() => postgresRepo(orgs).insertAll(newOrg))).toBe(4);
    const upsert = () =>
      postgresRepo(orgs).upsertAll(newOrg, { onConflict: ['slug'], onMatch: 'nothing' });
    expect(await pageLookupWriteLookup(upsert)).toBe(4);
  });

  test('a bulk write to another entity leaves the preload intact', async () => {
    // Three, not four: the second lookup is memory, so the preload is what is being counted —
    // without it every case here would read four and prove nothing.
    expect(await pageLookupWriteLookup(() => repo().insertAll([invoice(5)]))).toBe(3);
    expect(client.texts[1]).toContain('"id" in ($1)');
  });
});
