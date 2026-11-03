// What `x db gen` writes for a same-tenant edge: the composite key, the unique index its target
// needs, and which phase each lands in. The first migration of a table is one transaction; anything
// touching a live table is the deferred step, with the old key held until the new one validates.

import { describe, expect, test } from 'bun:test';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { foreignKeysOf } from './foreign-key-plan';
import { generateMigration, snapshotOf } from './generate';
import { buildSchema } from './introspect';
import { recordRetired } from './retired';
import { sameTenantKeyName } from './same-tenant';
import { statementsOf } from './statement-split';

const column = (
  name: string,
  overrides: Partial<ColumnDescriptionLike> = {},
): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind: 'uuid',
  notNull: true,
  primaryKey: false,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
  ...overrides,
});

const table = (
  name: string,
  columns: readonly ColumnDescriptionLike[],
  overrides: Partial<EntityDescriptionLike> = {},
): EntityDescriptionLike => ({
  name,
  table: name,
  primaryKey: ['id'],
  columns: [column('id', { primaryKey: true }), column('org_id'), ...columns],
  indexes: [],
  ...overrides,
});

const SAME_TENANT = { column: 'org_id', targetColumn: 'org_id' };

const postRef = (overrides: Partial<ColumnDescriptionLike> = {}): ColumnDescriptionLike =>
  column('post_id', { references: 'posts.id', sameTenant: SAME_TENANT, ...overrides });

const posts = table('posts', []);
const comments = table('comments', [postRef()]);

const INDEX = 'posts_org_id_id_tenant_key';
const at = new Date('2026-11-02T12:00:00.000Z');

const plain = table('comments', [column('post_id', { references: 'posts.id' })]);

describe('unit · the composite key a same-tenant edge becomes', () => {
  test('the key pairs the two tenant columns and carries its own name', () => {
    expect(foreignKeysOf(comments)).toEqual([
      {
        name: 'comments_post_id_tenant_fkey',
        columns: ['org_id', 'post_id'],
        referencedTable: 'posts',
        referencedColumns: ['org_id', 'id'],
        onDelete: null,
      },
    ]);
  });

  test('the two tenant columns need not share a name', () => {
    const child = table('notes', [
      column('workspace_id'),
      column('post_id', {
        references: 'posts.id',
        sameTenant: { column: 'workspace_id', targetColumn: 'org_id' },
      }),
    ]);
    expect(foreignKeysOf(child)[0]?.columns).toEqual(['workspace_id', 'post_id']);
    expect(foreignKeysOf(child)[0]?.referencedColumns).toEqual(['org_id', 'id']);
  });

  test('set null names its own column: a bare one would null the tenant too', () => {
    const child = table('comments', [postRef({ onDelete: 'set null', notNull: false })]);
    const { up } = generateMigration({
      entities: [posts, child],
      name: 'init',
      now: at,
    });
    expect(up).toContain('references "posts" ("org_id", "id") on delete set null ("post_id");');
    expect(foreignKeysOf(child)[0]?.onDelete).toBe('set null (post_id)');
  });

  test('a plain edge to a root stays exactly what it was', () => {
    const orgs: EntityDescriptionLike = {
      name: 'orgs',
      table: 'orgs',
      primaryKey: ['id'],
      columns: [column('id', { primaryKey: true })],
      indexes: [],
    };
    const child = table('posts', [column('author_id', { references: 'orgs.id' })]);
    const { up } = generateMigration({ entities: [orgs, child], name: 'init', now: at });
    expect(up).toContain(
      'alter table "posts" add constraint "posts_author_id_fkey" foreign key ("author_id") references "orgs" ("id");',
    );
    expect(up).not.toContain('tenant');
  });

  test('a self-reference is composite and its table needs the index too', () => {
    const nodes = table('nodes', [
      column('parent_id', { references: 'nodes.id', sameTenant: SAME_TENANT, notNull: false }),
    ]);
    const { up } = generateMigration({ entities: [nodes], name: 'init', now: at });
    expect(up).toContain('create unique index "nodes_org_id_id_tenant_key" on "nodes"');
    expect(up).toContain(
      'foreign key ("org_id", "parent_id") references "nodes" ("org_id", "id");',
    );
  });

  test('a name past 63 bytes keeps its identity rather than truncating into another key', () => {
    const long = 'a_rather_long_table_name_that_goes_on_and_on';
    const a = sameTenantKeyName(long, 'first_reference_column_id');
    const b = sameTenantKeyName(long, 'first_reference_column_id_two');
    expect(new TextEncoder().encode(a).length).toBeLessThanOrEqual(63);
    expect(a).not.toBe(b);
    expect(sameTenantKeyName('comments', 'post_id')).toBe('comments_post_id_tenant_fkey');
  });
});

describe('unit · the unique index its target needs', () => {
  test('declared once per referenced table, however many edges reach it', () => {
    const likes = table('likes', [postRef()]);
    const { up, snapshot } = generateMigration({
      entities: [posts, comments, likes],
      name: 'init',
      now: at,
    });
    const builds = statementsOf(up).filter((statement) => statement.includes(INDEX));
    expect(builds).toHaveLength(1);
    expect(builds[0]).toBe(`create unique index "${INDEX}" on "posts" ("org_id", "id")`);
    expect(snapshot.tables.find((each) => each.name === 'posts')?.indexes).toEqual([
      {
        name: INDEX,
        columns: ['org_id', 'id'],
        unique: true,
        primary: false,
        where: null,
        order: null,
      },
    ]);
  });

  test('both new: index and key in one transaction, index first', () => {
    const migration = generateMigration({
      entities: [comments, posts],
      name: 'init',
      now: at,
    });
    expect(migration.transactional).toBe(true);
    expect(migration.followUp).toBeUndefined();
    const statements = statementsOf(migration.up);
    const index = statements.findIndex((each) => each.includes(INDEX));
    const key = statements.findIndex((each) => each.includes('comments_post_id_tenant_fkey'));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(key).toBeGreaterThan(index);
    expect(migration.up).not.toContain('not valid');
  });

  test('a composite primary key already answers: no second index', () => {
    const target = table('posts', [], { primaryKey: ['org_id', 'id'] });
    const { up } = generateMigration({ entities: [target, comments], name: 'init', now: at });
    expect(up).not.toContain(INDEX);
  });

  test('a declared unique over the same columns answers, whichever way round', () => {
    const target = table('posts', [], {
      indexes: [
        { name: 'posts_id_org', columns: ['id', 'org_id'], unique: true, where: null, order: null },
      ],
    });
    const { up } = generateMigration({ entities: [target, comments], name: 'init', now: at });
    expect(up).not.toContain(INDEX);
  });

  test('a PARTIAL unique does not answer: Postgres refuses a key over one', () => {
    const target = table('posts', [], {
      indexes: [
        {
          name: 'posts_id_org_live',
          columns: ['org_id', 'id'],
          unique: true,
          where: 'deleted_at is null',
          order: null,
        },
      ],
    });
    const { up } = generateMigration({ entities: [target, comments], name: 'init', now: at });
    expect(up).toContain(INDEX);
  });

  test('snapshotOf records it too, so the next gen has nothing to do', () => {
    const first = snapshotOf([posts, comments]);
    const again = generateMigration({
      entities: [posts, comments],
      current: first,
      name: 'again',
      now: at,
    });
    expect(again.up.trim()).toBe('');
    expect(again.followUp).toBeUndefined();
  });
});

describe('unit · onto a live table', () => {
  const before = snapshotOf([posts, plain]);

  const upgrade = () =>
    generateMigration({
      entities: [posts, comments],
      current: before,
      name: 'same-tenant keys',
      now: at,
    });

  test('index, key not valid, validate, old key dropped last, in that order', () => {
    const migration = upgrade();
    expect(migration.transactional).toBe(false);
    // A chunk keeps the comment above it, and the step's marker is the first thing in the file.
    const body = statementsOf(migration.up).map((each) => each.replace(/^(--.*\n)+/, ''));
    expect(body).toEqual([
      `create unique index concurrently if not exists "${INDEX}" on "posts" ("org_id", "id")`,
      'alter table "comments" drop constraint if exists "comments_post_id_tenant_fkey", add constraint "comments_post_id_tenant_fkey" foreign key ("org_id", "post_id") references "posts" ("org_id", "id") not valid',
      'alter table "comments" validate constraint "comments_post_id_tenant_fkey"',
      'alter table "comments" drop constraint if exists "comments_post_id_fkey"',
    ]);
  });

  test('the way back restores the old key before it drops the new one and its index', () => {
    const statements = statementsOf(upgrade().down);
    const restored = statements.findIndex((each) =>
      each.includes('add constraint "comments_post_id_fkey"'),
    );
    const dropped = statements.findIndex((each) =>
      each.includes('drop constraint if exists "comments_post_id_tenant_fkey"'),
    );
    const index = statements.findIndex((each) => each.includes(`drop index concurrently`));
    expect(restored).toBeGreaterThanOrEqual(0);
    expect(dropped).toBeGreaterThan(restored);
    expect(index).toBeGreaterThan(dropped);
  });

  test('a new child over a live target defers its key behind the index it needs', () => {
    const migration = generateMigration({
      entities: [posts, comments],
      current: snapshotOf([posts]),
      name: 'comments',
      now: at,
    });
    expect(migration.up).toContain('create table "comments"');
    expect(migration.up).not.toContain('foreign key');
    const step = migration.followUp;
    expect(step?.transactional).toBe(false);
    expect(step?.up).toContain(`create unique index concurrently if not exists "${INDEX}"`);
    expect(step?.up).toContain('add constraint "comments_post_id_tenant_fkey"');
    expect(step?.up).toContain('validate constraint "comments_post_id_tenant_fkey"');
    // The transactional step's sidecar has to describe what that step left behind.
    const held = migration.snapshot.tables.find((each) => each.name === 'comments');
    expect(held?.foreignKeys).toEqual([]);
    const target = migration.snapshot.tables.find((each) => each.name === 'posts');
    expect(target?.indexes.map((index) => index.name)).not.toContain(INDEX);
  });

  test('crossTenant going away and coming back is a plain key again', () => {
    const migration = generateMigration({
      entities: [posts, plain],
      current: snapshotOf([posts, comments]),
      name: 'shared catalog',
      now: at,
    });
    expect(migration.up).toContain('add constraint "comments_post_id_fkey"');
    expect(migration.up).toContain('drop constraint if exists "comments_post_id_tenant_fkey"');
    expect(migration.up).toContain(`drop index concurrently if exists "${INDEX}"`);
  });
});

describe('unit · retiring a target’s last same-tenant reference', () => {
  const comments2 = table('comments', [], { retired: ['post_id'] });
  const before = snapshotOf([posts, table('comments', [postRef({ notNull: false })])]);
  const retire = () =>
    generateMigration({
      entities: [posts, comments2],
      current: before,
      name: 'retire post_id',
      now: at,
    });

  test('the index stays: the recorded key over the retired column still needs it (2BP01)', () => {
    const { up, followUp, snapshot } = retire();
    expect(`${up}\n${followUp?.up ?? ''}`).not.toContain('drop index');
    const target = snapshot.tables.find((each) => each.name === 'posts');
    expect(target?.indexes.map((index) => index.name)).toContain(INDEX);
  });

  test('source drift reads the same: recordRetired keeps the index on the record', () => {
    const declared = recordRetired(snapshotOf([posts, comments2]), [posts, comments2], before);
    const target = declared.tables.find((each) => each.name === 'posts');
    expect(target?.indexes.map((index) => index.name)).toEqual([INDEX]);
  });

  test('the drop that follows removes the index, after the column took the key', () => {
    const dropped = generateMigration({
      entities: [posts, table('comments', [])],
      current: retire().snapshot,
      name: 'drop post_id',
      now: at,
      allowDestructive: true,
    });
    expect(dropped.up).toContain('drop column "post_id"');
    expect(dropped.followUp?.up).toContain(`drop index concurrently if exists "${INDEX}"`);
  });
});

describe('unit · a set null list as the catalog prints it', () => {
  const rowOf = (columns: string) => ({
    table_name: 'comments',
    constraint_name: 'k',
    columns: ['org_id', 'user'],
    referenced_table: 'users',
    referenced_columns: ['org_id', 'id'],
    on_delete: 'n',
    set_null_columns: columns,
  });
  const ruleOf = (columns: string) =>
    buildSchema(
      'public',
      [],
      [
        {
          table_name: 'comments',
          column_name: 'id',
          data_type: 'uuid',
          is_nullable: 'NO',
          column_default: null,
          ordinal_position: 1,
        },
      ],
      [],
      [rowOf(columns)],
    ).tables[0]?.foreignKeys[0]?.onDelete;

  test('a reserved word comes back quoted and compares unquoted', () => {
    expect(ruleOf('"user"')).toBe('set null (user)');
  });

  test('every listed name, and a plain one is untouched', () => {
    expect(ruleOf('post_id, "user"')).toBe('set null (post_id, user)');
    expect(ruleOf('post_id')).toBe('set null (post_id)');
  });
});

describe('unit · a target whose entity name is not its table', () => {
  test('the index lands on the table the reference names', () => {
    const named = { ...table('posts', []), name: 'Post' };
    const { up } = generateMigration({ entities: [named, comments], name: 'init', now: at });
    expect(up).toContain(`create unique index "${INDEX}" on "posts"`);
  });
});
