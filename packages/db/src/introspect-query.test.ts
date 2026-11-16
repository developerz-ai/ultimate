// introspect() over a recorded executor: the catalog queries it issues and the schema it builds
// from their rows. Split from introspect.test.ts, which keeps buildSchema over literal rows.

import { afterEach, describe, expect, test } from 'bun:test';
import { setDbClient } from './client';
import { recordingClient } from './fake';
import { findTable, introspectSchema } from './introspect';

afterEach(() => {
  setDbClient(undefined);
});

describe('introspect', () => {
  test('sends eight catalog queries and folds their rows through buildSchema', async () => {
    const client = recordingClient();
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
    // Registered AFTER the foreign-key stub and matched on `contype`, because both queries read
    // `pg_constraint` and the last matching stub wins: the fifth query asks for CHECK names and
    // answering it with a foreign key's row is a `checkNames` nothing in the catalog holds.
    client.on(/contype = 'c'/, {
      rows: [{ table_name: 'posts', constraint_name: 'posts_status_check' }],
    });
    // The sixth: enabled trigger NAMES, the catalog's half of an append-only table.
    client.on(/pg_trigger/, {
      rows: [{ table_name: 'posts', trigger_name: 'ultimate_append_only' }],
    });

    // The seventh names the partitioned parents (`partitioned-tables.ts`), the eighth the binding
    // policies (`row-security-catalog.ts`); none of either here.
    const schema = await introspectSchema({ client });

    expect(client.statements).toHaveLength(8);
    expect(findTable(schema, 'posts')).not.toHaveProperty('partitioned');
    const posts = findTable(schema, 'posts');
    expect(posts?.columns).toHaveLength(1);
    expect(posts?.primaryKey).toEqual(['id']);
    expect(posts?.foreignKeys).toHaveLength(1);
    // Names only. `checks` stays absent on a catalog read — it is the DECLARED side's field, and a
    // rewritten predicate landing on it is what `checkPlan` would then diff a generated one against.
    expect(posts?.checkNames).toEqual(['posts_status_check']);
    expect(posts?.checks).toBeUndefined();
    expect(posts?.triggerNames).toEqual(['ultimate_append_only']);
    expect(posts?.appendOnly).toBeUndefined();
  });

  test('defaults `exclude` to `[x_migrations]`, so the ledger never appears as a table', async () => {
    const client = recordingClient();
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

    const schema = await introspectSchema({ client });
    expect(schema.tables.map((t) => t.name)).toEqual(['posts']);
  });

  test('an explicit `exclude` overrides the default rather than adding to it', async () => {
    const client = recordingClient();
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

    const schema = await introspectSchema({ client, exclude: ['scratch'] });
    // x_migrations is back, because passing `exclude` replaced the default rather than adding to it.
    expect(schema.tables.map((t) => t.name)).toEqual(['x_migrations']);
  });

  test('`schema` option is threaded into every query and the returned rows', async () => {
    const client = recordingClient();
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

    const schema = await introspectSchema({ client, schema: 'tenant_a' });
    expect(findTable(schema, 'posts')?.schema).toBe('tenant_a');
    expect(client.statements.every((s) => s.values.includes('tenant_a'))).toBe(true);
  });

  test('the foreign-key query pairs conkey with confkey by ordinality, never with `= any`', async () => {
    const client = recordingClient();
    client.on(/information_schema\.columns/, { rows: [] });
    client.on(/pg_index/, { rows: [] });
    client.on(/pg_constraint/, { rows: [] });

    await introspectSchema({ client });

    const constraints = client.texts.find((text) => text.includes('pg_constraint'));
    expect(constraints).toBeDefined();
    // `= any(conkey)` joined each side independently: for a two-column key that is a cross product,
    // four rows where there are two, so `array_agg` emitted duplicated, misaligned column pairs.
    expect(constraints).not.toContain('any(c.conkey)');
    expect(constraints).not.toContain('any(c.confkey)');
    expect(constraints).toContain('unnest(c.conkey, c.confkey) with ordinality');
    expect(constraints).toContain('order by k.ord');
  });

  test('the CHECK query reads conname and never a definition', async () => {
    const client = recordingClient();
    await introspectSchema({ client });
    const checks = client.texts.find((text) => text.includes("contype = 'c'"));
    expect(checks).toBeDefined();
    // The whole reason this query is name-only: `pg_get_constraintdef` answers Postgres' own
    // rewriting of the predicate, which no generated spelling can equal — so a `checks` filled
    // from it makes `x db gen` drop and re-add every constraint in the app on every run, forever.
    expect(checks).not.toContain('pg_get_constraintdef');
    expect(checks).toContain('c.conname as constraint_name');
  });

  test('with no `client` option the ambient client is used, so `x db` needs no wiring', async () => {
    const client = recordingClient();
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

    const schema = await introspectSchema();

    expect(client.statements).toHaveLength(8);
    expect(schema.tables.map((t) => t.name)).toEqual(['posts']);
  });

  // Eight catalog reads, none depending on another's answer: serial, a remote database paid eight
  // round trips at every CLI command and every boot drift check. Every read is held unanswered, so
  // a serial loop has exactly one in flight however many turns pass; all eight means sent together.
  test('the eight catalog reads are in flight together', async () => {
    const client = recordingClient();
    let inFlight = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding: typeof client = {
      ...client,
      query: async <T>(fragment: Parameters<typeof client.query>[0]) => {
        inFlight += 1;
        await held;
        return client.query<T>(fragment);
      },
    };
    const reading = introspectSchema({ client: holding });
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    expect(inFlight).toBe(8);
    release();
    await reading;
    expect(client.statements).toHaveLength(8);
  });
});
