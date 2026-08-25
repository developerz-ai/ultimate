// The two snapshot fields a sidecar carries and the live catalog never does — `checks` and a
// column's `generated` expression. Both are the SNAPSHOT's own spelling, so both have to survive
// the round trip through disk or the next `x db gen` re-emits a statement the database already
// holds: `42710` for a constraint, a full column rebuild for a generated one.

import { describe, expect, test } from 'bun:test';
import { generateMigration, snapshotOf } from './generate';
import { parseSnapshot } from './snapshot-parse';

const sidecar = (table: Record<string, unknown>): unknown => ({
  tables: [
    {
      schema: 'public',
      name: 'posts',
      primaryKey: ['id'],
      columns: [{ name: 'id', dataType: 'uuid', nullable: false, default: null, position: 1 }],
      indexes: [],
      foreignKeys: [],
      ...table,
    },
  ],
});

const tableOf = (value: unknown) => parseSnapshot(value)?.tables[0];

describe('parseSnapshot · checks', () => {
  test('a recorded check round-trips whole', () => {
    const parsed = tableOf(
      sidecar({ checks: [{ name: 'posts_x_check', expression: 'like_count >= 0' }] }),
    );
    expect(parsed?.checks).toEqual([{ name: 'posts_x_check', expression: 'like_count >= 0' }]);
  });

  test('a sidecar written before the field existed records NOTHING, never an empty list', () => {
    // The difference decides the repair path for every app that has already generated a migration:
    // absent means "add the constraints the database is missing", `[]` would mean "it has none".
    expect(tableOf(sidecar({}))).not.toHaveProperty('checks');
  });

  test('a malformed check rejects the whole snapshot — a partial table is not a smaller one', () => {
    expect(parseSnapshot(sidecar({ checks: [{ name: 'posts_x_check' }] }))).toBeUndefined();
    expect(parseSnapshot(sidecar({ checks: 'posts_x_check' }))).toBeUndefined();
  });

  test('a snapshot through JSON and back generates NOTHING the second time', () => {
    const entity = {
      name: 'Post',
      table: 'posts',
      primaryKey: ['id'],
      columns: [
        {
          property: 'id',
          column: 'id',
          kind: 'uuid',
          notNull: true,
          primaryKey: true,
          unique: false,
          hasDefault: true,
          check: null,
          references: null,
        },
      ],
      indexes: [],
      invariants: [
        {
          name: 'post_id_present',
          kind: 'check' as const,
          message: 'x',
          sql: 'id is not null',
          where: null,
        },
      ],
    };
    const written = JSON.parse(JSON.stringify(snapshotOf([entity])));
    const current = parseSnapshot(written);
    expect(current).toBeDefined();
    const second = generateMigration({
      entities: [entity],
      current,
      name: 'again',
      now: new Date('2026-08-25T00:00:00.000Z'),
    });
    expect(second.up).toBe('');
  });
});

describe('parseSnapshot · generated', () => {
  test("a column's generation expression survives the round trip", () => {
    const parsed = tableOf(
      sidecar({
        columns: [
          {
            name: 'tsv',
            dataType: 'tsvector',
            nullable: false,
            default: null,
            position: 1,
            generated: "to_tsvector('english', title)",
          },
        ],
      }),
    );
    expect(parsed?.columns[0]?.generated).toBe("to_tsvector('english', title)");
  });

  test('an ordinary column gains no key', () => {
    expect(tableOf(sidecar({}))?.columns[0]).not.toHaveProperty('generated');
  });
});
