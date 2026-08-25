// Single responsibility: the constraints a generated migration claims to create, read back out of
// the CATALOG of a real server. A string comparison cannot say a UNIQUE constraint exists — it can
// only say the generator wrote the words — and that is precisely how ten invariants stayed missing
// under a green gate: the `drift` step compares a source hash to a sidecar and never reads the SQL.
//
// Every table here is dropped on the way in and on the way out; nothing is left behind.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPostgresClient, type PostgresClient } from './client';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration, snapshotOf } from './generate';
import { raw } from './sql';
import { statementsOf } from './statement-split';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const column = (
  name: string,
  overrides: Partial<ColumnDescriptionLike> = {},
): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind: 'text',
  notNull: false,
  primaryKey: false,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
  ...overrides,
});

const TABLE = 'inv_members';

const members = (overrides: Partial<EntityDescriptionLike> = {}): EntityDescriptionLike => ({
  name: 'InvMember',
  table: TABLE,
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'uuid', primaryKey: true, notNull: true, hasDefault: true }),
    column('org_id', { kind: 'uuid', notNull: true }),
    column('user_id', { kind: 'uuid', notNull: true }),
    column('email', { kind: 'text', notNull: true }),
    column('role', {
      kind: 'text',
      notNull: true,
      hasDefault: true,
      default: { kind: 'value', value: 'author' },
    }),
    column('digest_opt_in', {
      kind: 'boolean',
      notNull: true,
      hasDefault: true,
      default: { kind: 'value', value: true },
    }),
    column('like_count', {
      kind: 'integer',
      notNull: true,
      hasDefault: true,
      default: { kind: 'value', value: 0 },
    }),
  ],
  indexes: [],
  invariants: [
    {
      name: 'member_email_shape',
      kind: 'check',
      message: 'email must contain @',
      sql: "position('@' in email) > 1",
      where: null,
    },
    {
      name: 'member_like_count_non_negative',
      kind: 'check',
      message: 'like_count >= 0',
      sql: 'like_count >= 0',
      where: null,
    },
    {
      name: 'member_unique_per_org',
      kind: 'unique',
      message: 'org_id, user_id must be unique',
      sql: 'org_id, user_id',
      where: null,
    },
  ],
  ...overrides,
});

const at = new Date('2026-08-25T00:00:00.000Z');
const uuid = (tail: string): string => `00000000-0000-7000-8000-${tail.padStart(12, '0')}`;

describe.skipIf(!hasPostgres)('live · postgres · invariants reach the catalog', () => {
  let client: PostgresClient;

  const apply = async (sql: string): Promise<void> => {
    for (const statement of statementsOf(sql)) await client.execute(raw(statement));
  };

  /** What the SERVER holds, not what the generator wrote: `pg_constraint` and `pg_indexes`. */
  const checkNames = async (): Promise<readonly string[]> => {
    const rows = await client.query<{ conname: string }>(
      raw(
        `select conname from pg_constraint c join pg_class t on t.oid = c.conrelid ` +
          `where t.relname = '${TABLE}' and c.contype = 'c' order by conname`,
      ),
    );
    return rows.map((row) => row.conname);
  };

  const uniqueIndexes = async (): Promise<readonly string[]> => {
    const rows = await client.query<{ indexname: string }>(
      raw(
        `select indexname from pg_indexes where tablename = '${TABLE}' ` +
          `and indexdef like 'CREATE UNIQUE%' order by indexname`,
      ),
    );
    return rows.map((row) => row.indexname);
  };

  const columnDefault = async (name: string): Promise<string | null> => {
    const rows = await client.query<{ column_default: string | null }>(
      raw(
        `select column_default from information_schema.columns ` +
          `where table_name = '${TABLE}' and column_name = '${name}'`,
      ),
    );
    return rows[0]?.column_default ?? null;
  };

  beforeAll(async () => {
    client = createPostgresClient({ url: url ?? '' });
    await client.execute(raw(`drop table if exists "${TABLE}" cascade`));
    await apply(generateMigration({ entities: [members()], name: 'init', now: at }).up);
  });

  afterAll(async () => {
    await client.execute(raw(`drop table if exists "${TABLE}" cascade`));
    await client.close();
  });

  test('every check invariant exists as a named CHECK constraint', async () => {
    expect(await checkNames()).toEqual([
      `${TABLE}_member_email_shape_check`,
      `${TABLE}_member_like_count_non_negative_check`,
    ]);
  });

  test('the unique invariant exists as a named unique index', async () => {
    expect(await uniqueIndexes()).toContain(`${TABLE}_member_unique_per_org_key`);
  });

  test('the CHECK rejects a row the entity forbids', async () => {
    const insert = client.execute(
      raw(
        `insert into "${TABLE}" ("id", "org_id", "user_id", "email") ` +
          `values ('${uuid('1')}', '${uuid('a')}', '${uuid('b')}', 'nope')`,
      ),
    );
    await expect(insert).rejects.toThrow();
  });

  test('the composite UNIQUE rejects the second write of the same pair', async () => {
    const insert = (id: string): Promise<unknown> =>
      client.execute(
        raw(
          `insert into "${TABLE}" ("id", "org_id", "user_id", "email") ` +
            `values ('${id}', '${uuid('a')}', '${uuid('b')}', 'a@b.c')`,
        ),
      );
    await insert(uuid('2'));
    // This is the claim `inviteMember` rests on: without the constraint the replay writes a second
    // membership row and the server says nothing.
    await expect(insert(uuid('3'))).rejects.toThrow();
  });

  test('the declared scalar defaults are the DEFAULTS the catalog holds', async () => {
    expect(await columnDefault('role')).toBe("'author'::text");
    expect(await columnDefault('digest_opt_in')).toBe('true');
    expect(await columnDefault('like_count')).toBe('0');
  });

  test('a row that names none of them takes the entity values, from the database', async () => {
    await client.execute(
      raw(
        `insert into "${TABLE}" ("id", "org_id", "user_id", "email") ` +
          `values ('${uuid('4')}', '${uuid('c')}', '${uuid('d')}', 'c@d.e')`,
      ),
    );
    const rows = await client.query<{ role: string; digest_opt_in: boolean; like_count: number }>(
      raw(`select role, digest_opt_in, like_count from "${TABLE}" where id = '${uuid('4')}'`),
    );
    expect(rows[0]?.role).toBe('author');
    expect(rows[0]?.digest_opt_in).toBe(true);
    expect(Number(rows[0]?.like_count)).toBe(0);
  });

  test('the second migration is empty AND applies — the generator does not repeat itself', async () => {
    const second = generateMigration({
      entities: [members()],
      current: snapshotOf([members()]),
      name: 'again',
      now: at,
    });
    expect(second.up).toBe('');
    // A constraint emitted but not recorded would be `42710` here rather than an empty string.
    await apply(second.up);
    expect(await checkNames()).toHaveLength(2);
  });

  test('a snapshot with no constraints recorded ADDS them, and the down takes them off', async () => {
    // The repair path for every app that generated a migration before invariants reached the SQL.
    const bare = 'inv_bare';
    const entity = members({ table: bare });
    await client.execute(raw(`drop table if exists "${bare}" cascade`));
    try {
      await apply(
        generateMigration({
          entities: [members({ table: bare, invariants: [] })],
          name: 'a',
          now: at,
        }).up,
      );
      const repair = generateMigration({
        entities: [entity],
        current: snapshotOf([members({ table: bare, invariants: [] })]),
        name: 'add invariants',
        now: at,
      });
      await apply(repair.up);
      const rows = await client.query<{ conname: string }>(
        raw(
          `select conname from pg_constraint c join pg_class t on t.oid = c.conrelid ` +
            `where t.relname = '${bare}' and c.contype = 'c' order by conname`,
        ),
      );
      expect(rows.map((row) => row.conname)).toEqual([
        `${bare}_member_email_shape_check`,
        `${bare}_member_like_count_non_negative_check`,
      ]);
      // And back: the reversal has to be applicable too, or the migration is not reversible.
      await apply(repair.down);
      const after = await client.query<{ conname: string }>(
        raw(
          `select conname from pg_constraint c join pg_class t on t.oid = c.conrelid ` +
            `where t.relname = '${bare}' and c.contype = 'c'`,
        ),
      );
      expect(after).toHaveLength(0);
    } finally {
      await client.execute(raw(`drop table if exists "${bare}" cascade`));
    }
  });
});
