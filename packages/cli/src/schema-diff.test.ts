// The comparison the `drift` step had no way to make: two GENERATED snapshots, held field for
// field. Every case here is a shape a real app was in while its gate was green — a sidecar that
// predates `checks`, a default the migration never carried, a constraint the declaration lost.

import { describe, expect, test } from 'bun:test';
import type { IndexDescription, SchemaDescription, TableDescription } from '@ultimat3/db';
import { diffDeclaredSchema } from './schema-diff';

const table = (over: Partial<TableDescription> = {}): TableDescription => ({
  schema: 'public',
  name: 'comments',
  columns: [
    { name: 'id', dataType: 'uuid', nullable: false, default: 'gen_random_uuid()', position: 1 },
    { name: 'body', dataType: 'text', nullable: false, default: null, position: 2 },
  ],
  primaryKey: ['id'],
  indexes: [],
  foreignKeys: [],
  ...over,
});

const schema = (...tables: readonly TableDescription[]): SchemaDescription => ({ tables });

const CHECK = {
  name: 'comments_comment_body_present_check',
  expression: 'length(btrim(body)) > 0',
} as const;

/** The first declared index, typed as the thing it is — `as never` makes a spread illegal, and a
 *  spread of an unchecked value is how a fixture stops describing the shape it claims to. */
const firstIndex = (source: TableDescription): IndexDescription => {
  const found = source.indexes[0];
  if (found === undefined) return expect.unreachable('the fixture declares an index');
  return found;
};

describe('unit · declared schema vs recorded snapshot', () => {
  // The `dummy/social-media-clone` state, reproduced: nine declared CHECKs had never reached any
  // database, the schema source had not moved, so the `.hash` sidecar matched and the gate was
  // green. This is the one test whose red is the whole point of the module.
  test('a declared check no snapshot recorded is an unmigrated difference', () => {
    const differences = diffDeclaredSchema(schema(table({ checks: [CHECK] })), schema(table()));
    expect(differences).toHaveLength(1);
    expect(differences[0]?.direction).toBe('unmigrated');
    expect(differences[0]?.part).toBe('check');
    expect(differences[0]?.name).toBe(CHECK.name);
    expect(differences[0]?.table).toBe('comments');
  });

  // `TableDescription.checks` is absent — never `[]` — on a table declaring none. Both sides
  // normalise to empty or every app whose sidecar predates the field reports a difference over a
  // table that never had a constraint to lose.
  test('absent checks on both sides is agreement, never a difference', () => {
    expect(diffDeclaredSchema(schema(table()), schema(table()))).toEqual([]);
  });

  test('an empty checks array reads as the absent one, in either position', () => {
    expect(diffDeclaredSchema(schema(table({ checks: [] })), schema(table()))).toEqual([]);
    expect(diffDeclaredSchema(schema(table()), schema(table({ checks: [] })))).toEqual([]);
  });

  // The other direction, and it is a different finding: the migration carries a constraint the
  // entities no longer declare, so the database holds a rule nothing in source states.
  test('a recorded check the entities no longer declare is an undeclared difference', () => {
    const differences = diffDeclaredSchema(schema(table()), schema(table({ checks: [CHECK] })));
    expect(differences).toHaveLength(1);
    expect(differences[0]?.direction).toBe('undeclared');
    expect(differences[0]?.part).toBe('check');
  });

  test('a check whose predicate was rewritten is unmigrated, and names both spellings', () => {
    const differences = diffDeclaredSchema(
      schema(table({ checks: [CHECK] })),
      schema(table({ checks: [{ name: CHECK.name, expression: "body <> ''" }] })),
    );
    expect(differences).toHaveLength(1);
    expect(differences[0]?.direction).toBe('unmigrated');
    expect(differences[0]?.detail).toContain(CHECK.expression);
    expect(differences[0]?.detail).toContain("body <> ''");
  });

  // The nine scalar defaults the squash dropped. Both sides are generated spellings, which is why
  // this comparison can read a default at all and `@ultimat3/db`'s live `diffSchema` cannot.
  test('a declared default the migration recorded as nothing is unmigrated', () => {
    const declared = table({
      columns: [
        {
          name: 'id',
          dataType: 'uuid',
          nullable: false,
          default: 'gen_random_uuid()',
          position: 1,
        },
        { name: 'state', dataType: 'text', nullable: false, default: "'draft'", position: 2 },
      ],
    });
    const recorded = table({
      columns: [
        {
          name: 'id',
          dataType: 'uuid',
          nullable: false,
          default: 'gen_random_uuid()',
          position: 1,
        },
        { name: 'state', dataType: 'text', nullable: false, default: null, position: 2 },
      ],
    });
    const differences = diffDeclaredSchema(schema(declared), schema(recorded));
    expect(differences).toHaveLength(1);
    expect(differences[0]?.part).toBe('column');
    expect(differences[0]?.name).toBe('state');
    expect(differences[0]?.detail).toContain("'draft'");
  });

  test('a nullability the migration did not record is unmigrated', () => {
    const recorded = table({
      columns: [
        {
          name: 'id',
          dataType: 'uuid',
          nullable: false,
          default: 'gen_random_uuid()',
          position: 1,
        },
        { name: 'body', dataType: 'text', nullable: true, default: null, position: 2 },
      ],
    });
    const differences = diffDeclaredSchema(schema(table()), schema(recorded));
    expect(differences).toHaveLength(1);
    expect(differences[0]?.detail).toContain('not null');
  });

  // The two UNIQUEs the squash lost arrive here: `declaredIndexes` folds a `unique` invariant into
  // the index list, so a sidecar written before invariants were projected records neither.
  test('a declared unique index no snapshot recorded is unmigrated', () => {
    const declared = table({
      indexes: [
        {
          name: 'comments_post_id_author_id_key',
          columns: ['post_id', 'author_id'],
          unique: true,
          primary: false,
          where: null,
          order: null,
        },
      ],
    });
    const differences = diffDeclaredSchema(schema(declared), schema(table()));
    expect(differences).toHaveLength(1);
    expect(differences[0]?.part).toBe('index');
    expect(differences[0]?.direction).toBe('unmigrated');
  });

  // Absent `using` is btree — Postgres' own default and what every index written before the field
  // existed is. Read literally, every existing app would report a difference on every index.
  test('an absent index method reads as btree on both sides', () => {
    const withMethod = table({
      indexes: [
        {
          name: 'comments_body_idx',
          columns: ['body'],
          unique: false,
          primary: false,
          where: null,
          order: null,
          using: 'btree',
        },
      ],
    });
    const without = table({
      indexes: [
        {
          name: 'comments_body_idx',
          columns: ['body'],
          unique: false,
          primary: false,
          where: null,
          order: null,
        },
      ],
    });
    expect(diffDeclaredSchema(schema(withMethod), schema(without))).toEqual([]);
    const gin = diffDeclaredSchema(
      schema(table({ indexes: [{ ...firstIndex(withMethod), using: 'gin' }] })),
      schema(without),
    );
    expect(gin).toHaveLength(1);
    expect(gin[0]?.detail).toContain('gin');
  });

  test("an index order of null reads as the 'asc' the other side spells out", () => {
    const spelled = table({
      indexes: [
        {
          name: 'comments_body_idx',
          columns: ['body'],
          unique: false,
          primary: false,
          where: null,
          order: 'asc',
        },
      ],
    });
    const implied = table({
      indexes: [
        {
          name: 'comments_body_idx',
          columns: ['body'],
          unique: false,
          primary: false,
          where: null,
          order: null,
        },
      ],
    });
    expect(diffDeclaredSchema(schema(spelled), schema(implied))).toEqual([]);
  });

  // A table missing entirely is ONE difference, never one per column: the repair is one statement
  // and a finding per column would be twelve instructions for it.
  test('a table no migration recorded is one difference, not one per column', () => {
    const differences = diffDeclaredSchema(schema(table()), schema());
    expect(differences).toHaveLength(1);
    expect(differences[0]?.part).toBe('table');
    expect(differences[0]?.direction).toBe('unmigrated');
  });

  test('a table the entities no longer declare is one undeclared difference', () => {
    const differences = diffDeclaredSchema(schema(), schema(table()));
    expect(differences).toHaveLength(1);
    expect(differences[0]?.part).toBe('table');
    expect(differences[0]?.direction).toBe('undeclared');
  });

  test('a foreign key whose on delete rule the migration never recorded is unmigrated', () => {
    const key = {
      name: 'comments_post_id_fkey',
      columns: ['post_id'],
      referencedTable: 'posts',
      referencedColumns: ['id'],
    };
    const differences = diffDeclaredSchema(
      schema(table({ foreignKeys: [{ ...key, onDelete: 'cascade' }] })),
      schema(table({ foreignKeys: [{ ...key, onDelete: null }] })),
    );
    expect(differences).toHaveLength(1);
    expect(differences[0]?.part).toBe('foreign key');
    expect(differences[0]?.detail).toContain('cascade');
  });

  test('two identical snapshots disagree about nothing', () => {
    expect(
      diffDeclaredSchema(schema(table({ checks: [CHECK] })), schema(table({ checks: [CHECK] }))),
    ).toEqual([]);
  });

  // The order is the report's order, and a gate that printed its findings in a different order on
  // two machines would make a diff of two runs unreadable.
  test('differences are ordered by table, then part, then name', () => {
    const differences = diffDeclaredSchema(
      schema(table({ name: 'zeta' }), table({ name: 'alpha', checks: [CHECK] })),
      schema(),
    );
    expect(differences.map((difference) => difference.table)).toEqual(['alpha', 'zeta']);
  });
});
