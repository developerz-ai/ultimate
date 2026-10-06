// A NOT NULL column added to an `appendOnly` table must arrive POPULATED in its own `add column`.
// The ordinary path emits it nullable with a `-- backfill …, then: set not null` note — and that
// backfill is an UPDATE the table's trigger refuses, so the note was an instruction nobody could
// carry out. Refused at generation instead, with the default as the fix.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration } from './generate';
import type { SchemaDescription } from './introspect';
import { snapshotJson } from './snapshot-json';
import { parseSnapshot } from './snapshot-parse';

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

const ID = column('id', { kind: 'uuid', notNull: true, primaryKey: true });

const ledger = (
  appendOnly: boolean,
  extra: readonly ColumnDescriptionLike[] = [],
): EntityDescriptionLike => ({
  name: 'ledger',
  table: 'ledger',
  primaryKey: ['id'],
  columns: [ID, column('body'), ...extra],
  indexes: [],
  ...(appendOnly ? { appendOnly } : {}),
});

const at = new Date('2026-10-06T00:00:00.000Z');
const generate = (entities: readonly EntityDescriptionLike[], current: SchemaDescription) =>
  generateMigration({ entities, current, name: 'ledger', now: at });

const recorded = (entity: EntityDescriptionLike): SchemaDescription => {
  const parsed = parseSnapshot(
    JSON.parse(snapshotJson(generate([entity], { tables: [] }).snapshot)),
  );
  if (parsed === undefined) expect.unreachable('the generator wrote a snapshot it cannot parse');
  return parsed;
};

const refusalOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return isUltimateError(error) ? `${error.code}\n${error.cause}\n${error.fix}` : String(error);
  }
  return 'generated';
};

const REQUIRED = column('memo', { notNull: true });

describe('appendOnly · adding a NOT NULL column', () => {
  test('with no default is refused at generation, naming the column and the default it needs', () => {
    const refused = refusalOf(() => generate([ledger(true, [REQUIRED])], recorded(ledger(true))));
    const [code, cause, fix] = refused.split('\n');
    expect(code).toBe('X_MIGRATION_APPEND_ONLY_BACKFILL');
    expect(cause).toContain('"ledger"');
    expect(cause).toContain('"memo"');
    expect(cause).toContain('append-only');
    expect(fix).toBe(
      'entity("ledger", { columns: { "memo": <builder>.default(<value>) } })   # then re-run x db gen',
    );
  });

  test('is refused too when this same migration turns appendOnly on', () => {
    const refused = refusalOf(() => generate([ledger(true, [REQUIRED])], recorded(ledger(false))));
    expect(refused.split('\n')[0]).toBe('X_MIGRATION_APPEND_ONLY_BACKFILL');
  });

  test('with a default lands NOT NULL and populated, in one statement and no backfill', () => {
    const defaulted = column('memo', {
      notNull: true,
      hasDefault: true,
      default: { kind: 'value', value: '' },
    });
    const migration = generate([ledger(true, [defaulted])], recorded(ledger(true)));
    expect(migration.up).toBe(`alter table "ledger" add column "memo" text default '' not null;`);
    expect(migration.up).not.toContain('backfill');
  });

  test('a nullable column needs nothing, and a table that is not append-only keeps its note', () => {
    expect(generate([ledger(true, [column('memo')])], recorded(ledger(true))).up).toBe(
      'alter table "ledger" add column "memo" text;',
    );
    expect(generate([ledger(false, [REQUIRED])], recorded(ledger(false))).up).toContain(
      '-- backfill "memo", then:',
    );
  });
});

describe('appendOnly · an existing column turned NOT NULL', () => {
  const NULLABLE = column('memo');

  test('is refused: the backfill its note asks for is an UPDATE the trigger refuses', () => {
    const refused = refusalOf(() =>
      generate([ledger(true, [REQUIRED])], recorded(ledger(true, [NULLABLE]))),
    );
    const [code, cause, fix] = refused.split('\n');
    expect(code).toBe('X_MIGRATION_APPEND_ONLY_BACKFILL');
    expect(cause).toContain('turns NOT NULL its column "memo"');
    // A default fills no NULL already stored, so the fix is not one.
    expect(fix).toStartWith('entity("ledger", { columns: { "memo": <builder>.nullable() } })');
  });

  test('is refused with a default declared too — `set default` fills no stored NULL', () => {
    const defaulted = column('memo', {
      notNull: true,
      hasDefault: true,
      default: { kind: 'value', value: '' },
    });
    const refused = refusalOf(() =>
      generate([ledger(true, [defaulted])], recorded(ledger(true, [NULLABLE]))),
    );
    expect(refused.split('\n')[0]).toBe('X_MIGRATION_APPEND_ONLY_BACKFILL');
  });

  test('a table that is not append-only keeps its backfill note, and dropping NOT NULL is fine', () => {
    expect(generate([ledger(false, [REQUIRED])], recorded(ledger(false, [NULLABLE]))).up).toBe(
      '-- backfill "memo", then: alter table "ledger" alter column "memo" set not null;',
    );
    expect(generate([ledger(true, [NULLABLE])], recorded(ledger(true, [REQUIRED]))).up).toBe(
      'alter table "ledger" alter column "memo" drop not null;',
    );
  });
});
