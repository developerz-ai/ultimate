// Single responsibility: an entity's declared invariants and scalar defaults reach the generated
// SQL, and anything that cannot reach it is said out loud. Every case here was silently dropped
// before 2026-08-25: ten invariants and nine defaults vanished between an entity and its own
// regenerated migration, and the `drift` gate step reads a source hash rather than the SQL, so the
// loss was green.

import { describe, expect, test } from 'bun:test';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration, snapshotOf } from './generate';

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

const members = (overrides: Partial<EntityDescriptionLike> = {}): EntityDescriptionLike => ({
  name: 'Member',
  table: 'members',
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
    column('created_at', { kind: 'timestamptz', notNull: true, hasDefault: true }),
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
      name: 'member_unique_per_org',
      kind: 'unique',
      message: 'org_id, user_id must be unique',
      sql: 'org_id, user_id',
      where: null,
    },
    {
      name: 'member_name_present',
      kind: 'assert',
      message: 'name must be present',
      sql: null,
      where: null,
    },
  ],
  ...overrides,
});

const at = new Date('2026-08-25T00:00:00.000Z');
const generate = (entity: EntityDescriptionLike, current?: EntityDescriptionLike) =>
  generateMigration({
    entities: [entity],
    name: 'init',
    now: at,
    ...(current === undefined ? {} : { current: snapshotOf([current]) }),
  });

describe('generateMigration · invariants', () => {
  test('a check invariant becomes a named CONSTRAINT on the created table', () => {
    const { up } = generate(members());
    expect(up).toContain(
      `constraint "members_member_email_shape_check" check (position('@' in email) > 1)`,
    );
  });

  test('a unique invariant becomes a named unique index over every column it names', () => {
    const { up } = generate(members());
    expect(up).toContain(
      'create unique index "members_member_unique_per_org_key" on "members" ("org_id", "user_id");',
    );
  });

  test('an assert invariant reaches no SQL — it is a rule the database was never told about', () => {
    const { up } = generate(members());
    expect(up).not.toContain('member_name_present');
  });

  test('the down of a created table is still the one drop — a constraint dies with its table', () => {
    const { down } = generate(members());
    expect(down.trim()).toBe('drop table "members";');
  });

  test('every declared invariant is recorded, so the SECOND generation is empty', () => {
    // The load-bearing property of the whole change: a constraint emitted but not snapshotted is
    // `42710`/`42P07` on the next `x db gen`, which is a worse failure than the silent drop.
    const second = generate(members(), members());
    expect(second.up).toBe('');
    expect(second.down).toBe('');
  });

  test('a snapshot that predates constraints gains them — the repair path for every app', () => {
    const before = snapshotOf([members({ invariants: [] })]);
    const migration = generateMigration({
      entities: [members()],
      current: before,
      name: 'add invariants',
      now: at,
    });
    expect(migration.up).toContain(
      `alter table "members" add constraint "members_member_email_shape_check" ` +
        `check (position('@' in email) > 1);`,
    );
    expect(migration.up).toContain(
      'create unique index "members_member_unique_per_org_key" on "members" ("org_id", "user_id");',
    );
    expect(migration.down).toContain(
      'alter table "members" drop constraint "members_member_email_shape_check";',
    );
  });

  test('a check whose expression moved is dropped and re-added, never left as it was', () => {
    const moved = members({
      invariants: [
        {
          name: 'member_email_shape',
          kind: 'check',
          message: 'email must contain @',
          sql: "position('@' in email) > 2",
          where: null,
        },
      ],
    });
    const migration = generateMigration({
      entities: [moved],
      current: snapshotOf([members({ invariants: members().invariants?.slice(0, 1) })]),
      name: 'tighten',
      now: at,
    });
    expect(migration.up).toContain(
      'alter table "members" drop constraint "members_member_email_shape_check";',
    );
    expect(migration.up).toContain("check (position('@' in email) > 2)");
  });

  test('a check the entity no longer declares is dropped, and the down restores it', () => {
    const migration = generateMigration({
      entities: [members({ invariants: [] })],
      current: snapshotOf([members()]),
      name: 'relax',
      now: at,
    });
    expect(migration.up).toContain(
      'alter table "members" drop constraint "members_member_email_shape_check";',
    );
    expect(migration.down).toContain(
      `alter table "members" add constraint "members_member_email_shape_check" ` +
        `check (position('@' in email) > 1);`,
    );
  });

  test('a partial unique invariant keeps its predicate — a soft-deleted row frees the slug', () => {
    const { up } = generate(
      members({
        invariants: [
          {
            name: 'member_unique_per_org',
            kind: 'unique',
            message: 'x',
            sql: 'org_id, user_id',
            where: 'deleted_at is null',
          },
        ],
      }),
    );
    expect(up).toContain(
      'create unique index "members_member_unique_per_org_key" on "members" ' +
        '("org_id", "user_id") where (deleted_at is null);',
    );
  });

  test('a unique invariant that lands on an existing index NAME emits one statement, not two', () => {
    // `invariant('slug', c.unique(['slug']))` on `members` derives `members_slug_key` — byte for
    // byte the name Postgres gives the index a `unique` column clause creates. Two `create unique
    // index` statements under one name is `42P07`, and the migration cannot be applied at all.
    const withSlug = (unique: boolean, invariants: EntityDescriptionLike['invariants']) =>
      members({
        columns: [
          column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
          column('slug', { kind: 'text', notNull: true, unique }),
        ],
        ...(unique
          ? {
              indexes: [
                {
                  name: 'members_slug_key',
                  columns: ['slug'],
                  unique: true,
                  where: null,
                  order: null,
                },
              ],
            }
          : { indexes: [] }),
        invariants,
      });
    const migration = generateMigration({
      // The column is already there, so no clause in this migration implies its index — both
      // declarations therefore need a statement of their own, and they are one statement.
      entities: [
        withSlug(true, [{ name: 'slug', kind: 'unique', message: 'x', sql: 'slug', where: null }]),
      ],
      current: snapshotOf([withSlug(false, [])]),
      name: 'make slug unique',
      now: at,
    });
    const statements = migration.up.split('\n').filter((line) => line.includes('members_slug_key'));
    expect(statements).toHaveLength(1);
  });

  test('an entity declaring no invariants emits byte-identical SQL to before the field existed', () => {
    const { up } = generate(members({ invariants: undefined }));
    expect(up).toBe(
      'create table "members" (\n' +
        '  "id" uuid default gen_random_uuid() not null,\n' +
        '  "org_id" uuid not null,\n' +
        '  "user_id" uuid not null,\n' +
        '  "email" text not null,\n' +
        `  "role" text default 'author' not null,\n` +
        '  "digest_opt_in" boolean default true not null,\n' +
        '  "like_count" integer default 0 not null,\n' +
        '  "created_at" timestamptz default now() not null,\n' +
        '  primary key ("id")\n' +
        ');',
    );
  });
});

describe('generateMigration · scalar defaults', () => {
  test('a declared literal default reaches the column clause', () => {
    const { up } = generate(members());
    expect(up).toContain(`"role" text default 'author' not null`);
    expect(up).toContain('"digest_opt_in" boolean default true not null');
    expect(up).toContain('"like_count" integer default 0 not null');
  });

  test('a literal default is recorded in the snapshot, so the second generation is empty', () => {
    expect(snapshotOf([members()]).tables[0]?.columns.find((c) => c.name === 'role')?.default).toBe(
      "'author'",
    );
  });

  test("a string default's own quote is doubled, never left to close the literal", () => {
    const { up } = generate(
      members({
        columns: [
          column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
          column('label', {
            hasDefault: true,
            default: { kind: 'value', value: "o'brien'); drop table t; --" },
          }),
        ],
        invariants: [],
      }),
    );
    expect(up).toContain(`default 'o''brien''); drop table t; --'`);
    expect(up).not.toContain('drop table t;\n');
  });

  test('a NOT NULL column with a literal default is added in ONE statement, never backfilled', () => {
    const migration = generateMigration({
      entities: [members()],
      current: snapshotOf([
        members({
          columns: members().columns.filter((each) => each.column !== 'role'),
          invariants: members().invariants,
        }),
      ]),
      name: 'add role',
      now: at,
    });
    expect(migration.up).toContain(
      `alter table "members" add column "role" text default 'author' not null;`,
    );
    expect(migration.up).not.toContain('-- backfill "role"');
  });
});

describe('generateMigration · what it cannot render', () => {
  test('a hasDefault column with no expression is REPORTED, never dropped in silence', () => {
    const entity = members({
      columns: [
        column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
        // What `@ultimat3/entity` projects today: the flag, with no value beside it.
        column('status', { kind: 'text', notNull: true, hasDefault: true }),
      ],
      invariants: [],
    });
    const migration = generate(entity);
    expect(migration.unrendered).toHaveLength(1);
    expect(migration.unrendered[0]?.name).toBe('status');
    expect(migration.unrendered[0]?.table).toBe('members');
    expect(migration.up).toContain('-- UNRENDERED');
    expect(migration.up).toContain('"members"."status"');
  });

  test('an EMPTY diff stays empty — a comment-only migration is a ledger row for nothing', () => {
    // `@ultimat3/cli` reads `up.trim().length === 0` as "nothing changed". A comment there makes
    // every `x db gen` on an app with an unrendered default write a file holding no statement.
    const entity = members({
      columns: [
        column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
        column('status', { kind: 'text', notNull: true, hasDefault: true }),
      ],
      invariants: [],
    });
    const second = generate(entity, entity);
    expect(second.up).toBe('');
    expect(second.unrendered).toHaveLength(1);
  });

  test('nothing unrendered means no comment at all — a marker on every file marks none', () => {
    const migration = generate(members());
    expect(migration.unrendered).toEqual([]);
    expect(migration.up).not.toContain('UNRENDERED');
  });

  test('a reported cause can never break out of its own line comment', () => {
    const entity = members({
      columns: [
        column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
        column('status\ndrop table t; --', { kind: 'text', hasDefault: true }),
      ],
      invariants: [],
    });
    // The column name itself is refused before it can be spliced anywhere.
    expect(() => generate(entity)).toThrow(/identifier|X_SQL_UNSAFE/);
  });
});

describe('generateMigration · a constraint name is an identifier, not a string', () => {
  test('an invariant name that closes the quote is refused, never spliced', () => {
    const entity = members({
      invariants: [
        {
          name: 'x" ); drop table "members"; --',
          kind: 'check',
          message: 'x',
          sql: '1 = 1',
          where: null,
        },
      ],
    });
    // The `fix:` is what is pinned, not just the throw: `identifier()` refuses the same string one
    // call later at every emission site, so the ONLY thing `constraintNameUnsafe` adds is the
    // instruction — "edit the invariant() call", where `identifierUnsafe` says "pass a plain
    // table/column name" to an author holding a schema module and no name.
    expect(() => generate(entity)).toThrow();
    try {
      generate(entity);
      expect.unreachable('a constraint name that closes its own quote must be refused');
    } catch (error) {
      const thrown = error as { code?: string; fix?: string };
      expect(thrown.code).toBe('X_SQL_UNSAFE');
      expect(thrown.fix).toContain("invariant('post_slug_unique'");
    }
  });

  test('a check expression carrying a second command is refused', () => {
    const entity = members({
      invariants: [
        {
          name: 'member_sneaky',
          kind: 'check',
          message: 'x',
          sql: '1 = 1); drop table "members"; --',
          where: null,
        },
      ],
    });
    expect(() => generate(entity)).toThrow();
  });

  test('a unique invariant naming something that is not a column list is refused', () => {
    const entity = members({
      invariants: [
        {
          name: 'member_sneaky',
          kind: 'unique',
          message: 'x',
          sql: 'org_id) ; drop table "members"; --',
          where: null,
        },
      ],
    });
    // Same reason as above: `createIndex` refuses the column one call later, and the only thing
    // this guard adds is the instruction that names the declaration.
    try {
      generate(entity);
      expect.unreachable('a unique list holding a second command must be refused');
    } catch (error) {
      const thrown = error as { code?: string; fix?: string };
      expect(thrown.code).toBe('X_SQL_UNSAFE');
      expect(thrown.fix).toContain("invariant('post_slug_unique'");
    }
  });

  test('a constraint name past 63 bytes is refused — Postgres truncates and says nothing', () => {
    const entity = members({
      invariants: [
        {
          name: `member_${'x'.repeat(60)}`,
          kind: 'check',
          message: 'x',
          sql: '1 = 1',
          where: null,
        },
      ],
    });
    expect(() => generate(entity)).toThrow(/63/);
  });
});
