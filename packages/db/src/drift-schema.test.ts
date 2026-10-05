// Single responsibility: a drift fix that repairs the database names the SCHEMA the table was read
// from. A `psql "$DATABASE_URL"` session starts on its own search_path, so an unqualified `alter
// table "posts"` for a table in `tenant_a` fails — or lands on a same-named table in `public`.

import { describe, expect, test } from 'bun:test';
import { diffSchema } from './drift';
import { schema, table } from './drift-fixture';
import type { TableDescription } from './introspect';

const KEY = {
  name: 'posts_org_id_fkey',
  columns: ['org_id'],
  referencedTable: 'orgs',
  referencedColumns: ['id'],
};

/** `posts`, as the catalog and as the migrations describe it — each disagreeing once per kind. */
const pair = (
  where: string,
): readonly [live: TableDescription, declared: TableDescription, unexpected: TableDescription] => {
  const base = { ...table('posts', ['id', 'org_id', 'slug']), schema: where };
  const nullable = (flag: boolean): TableDescription['columns'] =>
    base.columns.map((column) =>
      column.name === 'org_id' ? { ...column, nullable: flag } : column,
    );
  const pk = {
    name: 'posts_pkey',
    columns: ['id'],
    unique: true,
    primary: true,
    where: null,
    order: null,
  };
  return [
    {
      ...base,
      columns: nullable(true),
      indexes: [pk],
      checkNames: [],
      foreignKeys: [{ ...KEY, onDelete: 'a' }],
    },
    {
      ...base,
      columns: nullable(false),
      primaryKey: ['slug'],
      checks: [{ name: 'posts_slug_check', expression: "slug <> ''" }],
      foreignKeys: [{ ...KEY, onDelete: 'cascade' }],
    },
    { ...table('drafts', ['id']), schema: where },
  ];
};

const fixes = (where: string): Readonly<Record<string, string>> => {
  const [live, declared, unexpected] = pair(where);
  const report = diffSchema(schema(live, unexpected), schema(declared));
  return Object.fromEntries(report.differences.map((one) => [one.kind, one.fix]));
};

describe('a repair names the schema the table lives in', () => {
  const found = fixes('tenant_a');
  const head = `psql "$DATABASE_URL" -c 'set search_path = "tenant_a"; `;

  test('every statement fix sets the search_path first, in the same psql word', () => {
    expect(found['changed-column']).toStartWith(
      `${head}alter table "posts" alter column "org_id" set not null;'   # `,
    );
    expect(found['missing-check']).toStartWith(
      `${head}alter table "posts" add constraint "posts_slug_check" check (slug <> '\\'''\\'');'`,
    );
    // The REFERENCED table resolves through the same path, which a qualified `alter` alone misses.
    expect(found['changed-foreign-key']).toStartWith(
      `${head}alter table "posts" drop constraint "posts_org_id_fkey"; alter table "posts" add `,
    );
    expect(found['changed-primary-key']).toStartWith(
      `${head}alter table "posts" drop constraint "posts_pkey"; `,
    );
  });

  test('the unexpected-table inspection and its drop are qualified', () => {
    expect(found['unexpected-table']).toStartWith(
      `psql "$DATABASE_URL" -c '\\d "tenant_a"."drafts"'   # `,
    );
    expect(found['unexpected-table']).toContain('drop table "tenant_a"."drafts"; here');
    expect(found['unexpected-table']).toContain(
      'create table if not exists "tenant_a"."drafts" (…)',
    );
  });

  test('the default schema keeps the text every app has seen', () => {
    const plain = fixes('public');
    expect(plain['changed-column']).toStartWith(
      `psql "$DATABASE_URL" -c 'alter table "posts" alter column "org_id" set not null;'   # `,
    );
    expect(plain['unexpected-table']).toStartWith(`psql "$DATABASE_URL" -c '\\d "drafts"'   # `);
  });

  test('a schema no statement can spell degrades all five to a psql session', () => {
    for (const fix of Object.values(fixes('ten`x`ant'))) {
      if (fix === 'x db migrate') continue;
      expect(fix).toStartWith('psql "$DATABASE_URL"   # ');
      expect(fix).not.toContain('`');
    }
  });
});
