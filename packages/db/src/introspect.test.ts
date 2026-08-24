// Single responsibility: pin `buildSchema`'s row->description mapping (pure, no database) and
// `introspect()`'s four-query wiring against a recording client — the shape drift detection,
// the admin schema view and the MCP `schema.describe` tool all depend on. The fourth query is
// `nonAppRelations()`; what it excludes is pinned in `app-relation.test.ts`.

import { afterEach, describe, expect, test } from 'bun:test';
import { setDbClient } from './client';
import { createRecordingClient } from './fake';
import { buildSchema, findTable, introspect } from './introspect';

afterEach(() => {
  setDbClient(undefined);
});

describe('buildSchema', () => {
  test('groups columns, indexes and foreign keys by table, sorted by name', () => {
    const schema = buildSchema(
      'public',
      ['x_migrations'],
      [
        {
          table_name: 'posts',
          column_name: 'id',
          data_type: 'uuid',
          is_nullable: 'NO',
          column_default: null,
          ordinal_position: 1,
        },
        {
          table_name: 'posts',
          column_name: 'org_id',
          data_type: 'text',
          is_nullable: 'NO',
          column_default: null,
          ordinal_position: 2,
        },
        {
          table_name: 'orgs',
          column_name: 'id',
          data_type: 'uuid',
          is_nullable: 'NO',
          column_default: null,
          ordinal_position: 1,
        },
      ],
      [
        {
          table_name: 'posts',
          index_name: 'posts_pkey',
          is_unique: true,
          is_primary: true,
          columns: ['id'],
          predicate: null,
          descending: false,
        },
        {
          table_name: 'posts',
          index_name: 'posts_org_created_idx',
          is_unique: false,
          is_primary: false,
          columns: ['org_id', 'id'],
          predicate: '(deleted_at IS NULL)',
          descending: true,
        },
      ],
      [
        {
          table_name: 'posts',
          constraint_name: 'posts_org_id_fkey',
          columns: ['org_id'],
          referenced_table: 'orgs',
          referenced_columns: ['id'],
          on_delete: 'c',
        },
      ],
    );

    expect(schema.tables.map((t) => t.name)).toEqual(['orgs', 'posts']);

    const posts = findTable(schema, 'posts');
    expect(posts).toBeDefined();
    expect(posts?.columns.map((c) => c.name)).toEqual(['id', 'org_id']);
    expect(posts?.primaryKey).toEqual(['id']);
    // Sorted by index name: posts_org_created_idx < posts_pkey.
    expect(posts?.indexes.map((i) => i.name)).toEqual(['posts_org_created_idx', 'posts_pkey']);
    expect(posts?.foreignKeys).toEqual([
      {
        name: 'posts_org_id_fkey',
        columns: ['org_id'],
        referencedTable: 'orgs',
        referencedColumns: ['id'],
        onDelete: 'c',
      },
    ]);
  });

  test('excludes tables named in `excluded`, so framework bookkeeping never reads as drift', () => {
    const schema = buildSchema(
      'public',
      ['x_migrations'],
      [
        {
          table_name: 'x_migrations',
          column_name: 'id',
          data_type: 'text',
          is_nullable: 'NO',
          column_default: null,
          ordinal_position: 1,
        },
        {
          table_name: 'posts',
          column_name: 'id',
          data_type: 'uuid',
          is_nullable: 'NO',
          column_default: null,
          ordinal_position: 1,
        },
      ],
      [],
      [],
    );
    expect(schema.tables.map((t) => t.name)).toEqual(['posts']);
  });

  test('a table with no primary index gets an empty primaryKey, not a crash', () => {
    const schema = buildSchema(
      'public',
      [],
      [
        {
          table_name: 'events',
          column_name: 'id',
          data_type: 'uuid',
          is_nullable: 'NO',
          column_default: null,
          ordinal_position: 1,
        },
      ],
      [],
      [],
    );
    expect(findTable(schema, 'events')?.primaryKey).toEqual([]);
  });

  test('a descending flag becomes `desc`, and no flag becomes `null` — never `asc`', () => {
    const schema = buildSchema(
      'public',
      [],
      [
        {
          table_name: 'posts',
          column_name: 'id',
          data_type: 'uuid',
          is_nullable: 'NO',
          column_default: null,
          ordinal_position: 1,
        },
      ],
      [
        {
          table_name: 'posts',
          index_name: 'posts_created_idx',
          is_unique: false,
          is_primary: false,
          columns: ['created_at'],
          predicate: null,
          descending: true,
        },
        {
          table_name: 'posts',
          index_name: 'posts_slug_idx',
          is_unique: false,
          is_primary: false,
          columns: ['slug'],
          predicate: null,
          descending: false,
        },
      ],
      [],
    );
    const indexes = findTable(schema, 'posts')?.indexes ?? [];
    expect(indexes.find((i) => i.name === 'posts_created_idx')?.order).toBe('desc');
    expect(indexes.find((i) => i.name === 'posts_slug_idx')?.order).toBeNull();
  });

  test('a composite foreign key keeps its key order on both sides, never re-sorted', () => {
    const schema = buildSchema(
      'public',
      [],
      [
        {
          table_name: 'memberships',
          column_name: 'id',
          data_type: 'uuid',
          is_nullable: 'NO',
          column_default: null,
          ordinal_position: 1,
        },
      ],
      [],
      [
        {
          table_name: 'memberships',
          constraint_name: 'memberships_org_user_fkey',
          // Declared `(org_id, user_id) references users (tenant_id, id)`: source position 1 pairs
          // with target position 1. Sorting either list alphabetically would swap the target pair.
          columns: ['org_id', 'user_id'],
          referenced_table: 'users',
          referenced_columns: ['tenant_id', 'id'],
          on_delete: 'a',
        },
      ],
    );

    expect(findTable(schema, 'memberships')?.foreignKeys[0]).toEqual({
      name: 'memberships_org_user_fkey',
      columns: ['org_id', 'user_id'],
      referencedTable: 'users',
      referencedColumns: ['tenant_id', 'id'],
      onDelete: 'a',
    });
  });
});

describe('findTable', () => {
  test('returns undefined for a table the schema does not carry', () => {
    const schema = buildSchema('public', [], [], [], []);
    expect(findTable(schema, 'nope')).toBeUndefined();
  });
});

describe('introspect', () => {
  test('sends four catalog queries and folds their rows through buildSchema', async () => {
    const client = createRecordingClient();
    client.on(/information_schema\.columns/, {
      rows: [
        {
          table_name: 'posts',
          column_name: 'id',
          data_type: 'uuid',
          is_nullable: 'NO',
          column_default: null,
          ordinal_position: 1,
        },
      ],
    });
    client.on(/pg_index/, {
      rows: [
        {
          table_name: 'posts',
          index_name: 'posts_pkey',
          is_unique: true,
          is_primary: true,
          columns: ['id'],
          predicate: null,
          descending: false,
        },
      ],
    });
    client.on(/pg_constraint/, {
      rows: [
        {
          table_name: 'posts',
          constraint_name: 'posts_org_id_fkey',
          columns: ['org_id'],
          referenced_table: 'orgs',
          referenced_columns: ['id'],
          on_delete: null,
        },
      ],
    });

    const schema = await introspect({ client });

    expect(client.statements).toHaveLength(4);
    const posts = findTable(schema, 'posts');
    expect(posts?.columns).toHaveLength(1);
    expect(posts?.primaryKey).toEqual(['id']);
    expect(posts?.foreignKeys).toHaveLength(1);
  });

  test('defaults `exclude` to `[x_migrations]`, so the ledger never appears as a table', async () => {
    const client = createRecordingClient();
    client.on(/information_schema\.columns/, {
      rows: [
        {
          table_name: 'x_migrations',
          column_name: 'id',
          data_type: 'text',
          is_nullable: 'NO',
          column_default: null,
          ordinal_position: 1,
        },
        {
          table_name: 'posts',
          column_name: 'id',
          data_type: 'uuid',
          is_nullable: 'NO',
          column_default: null,
          ordinal_position: 1,
        },
      ],
    });
    client.on(/pg_index/, { rows: [] });
    client.on(/pg_constraint/, { rows: [] });

    const schema = await introspect({ client });
    expect(schema.tables.map((t) => t.name)).toEqual(['posts']);
  });

  test('an explicit `exclude` overrides the default rather than adding to it', async () => {
    const client = createRecordingClient();
    client.on(/information_schema\.columns/, {
      rows: [
        {
          table_name: 'x_migrations',
          column_name: 'id',
          data_type: 'text',
          is_nullable: 'NO',
          column_default: null,
          ordinal_position: 1,
        },
        {
          table_name: 'scratch',
          column_name: 'id',
          data_type: 'text',
          is_nullable: 'NO',
          column_default: null,
          ordinal_position: 1,
        },
      ],
    });
    client.on(/pg_index/, { rows: [] });
    client.on(/pg_constraint/, { rows: [] });

    const schema = await introspect({ client, exclude: ['scratch'] });
    // x_migrations is back, because passing `exclude` replaced the default rather than adding to it.
    expect(schema.tables.map((t) => t.name)).toEqual(['x_migrations']);
  });

  test('`schema` option is threaded into every query and the returned rows', async () => {
    const client = createRecordingClient();
    client.on(/information_schema\.columns/, {
      rows: [
        {
          table_name: 'posts',
          column_name: 'id',
          data_type: 'uuid',
          is_nullable: 'NO',
          column_default: null,
          ordinal_position: 1,
        },
      ],
    });
    client.on(/pg_index/, { rows: [] });
    client.on(/pg_constraint/, { rows: [] });

    const schema = await introspect({ client, schema: 'tenant_a' });
    expect(findTable(schema, 'posts')?.schema).toBe('tenant_a');
    expect(client.statements.every((s) => s.values.includes('tenant_a'))).toBe(true);
  });

  test('the foreign-key query pairs conkey with confkey by ordinality, never with `= any`', async () => {
    const client = createRecordingClient();
    client.on(/information_schema\.columns/, { rows: [] });
    client.on(/pg_index/, { rows: [] });
    client.on(/pg_constraint/, { rows: [] });

    await introspect({ client });

    const constraints = client.texts.find((text) => text.includes('pg_constraint'));
    expect(constraints).toBeDefined();
    // `= any(conkey)` joined each side independently: for a two-column key that is a cross product,
    // four rows where there are two, so `array_agg` emitted duplicated, misaligned column pairs.
    expect(constraints).not.toContain('any(c.conkey)');
    expect(constraints).not.toContain('any(c.confkey)');
    expect(constraints).toContain('unnest(c.conkey, c.confkey) with ordinality');
    expect(constraints).toContain('order by k.ord');
  });

  test('with no `client` option the ambient client is used, so `x db` needs no wiring', async () => {
    const client = createRecordingClient();
    client.on(/information_schema\.columns/, {
      rows: [
        {
          table_name: 'posts',
          column_name: 'id',
          data_type: 'uuid',
          is_nullable: 'NO',
          column_default: null,
          ordinal_position: 1,
        },
      ],
    });
    client.on(/pg_index/, { rows: [] });
    client.on(/pg_constraint/, { rows: [] });
    setDbClient(client);

    const schema = await introspect();

    expect(client.statements).toHaveLength(4);
    expect(schema.tables.map((t) => t.name)).toEqual(['posts']);
  });
});
