// `entity({ appendOnly: true })` reaching the DDL: the trigger that refuses UPDATE and DELETE is
// emitted ONCE (the snapshot records it, so the second `x db gen` is an empty diff), dropped when
// the declaration is, never read as destructive, and its SQL is pinned as a golden — a migration on
// disk is immutable, so a change to these bytes is a change every existing app would not receive.

import { describe, expect, test } from 'bun:test';
import { destructiveStatements } from './destructive';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration } from './generate';
import {
  APPEND_ONLY_FUNCTION,
  APPEND_ONLY_FUNCTION_SQL,
  APPEND_ONLY_TRIGGER,
  appendOnlyTriggerSql,
} from './generate-append-only';
import { findTable, type SchemaDescription } from './introspect';
import { snapshotJson } from './snapshot-json';
import { parseSnapshot } from './snapshot-parse';

const column = (name: string, primaryKey = false): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind: primaryKey ? 'uuid' : 'text',
  notNull: primaryKey,
  primaryKey,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
});

const entity = (table: string, appendOnly?: boolean): EntityDescriptionLike => ({
  name: table,
  table,
  primaryKey: ['id'],
  columns: [column('id', true), column('body')],
  indexes: [],
  ...(appendOnly === undefined ? {} : { appendOnly }),
});

const DROP_LEDGER = 'drop trigger if exists "ultimate_append_only" on "ledger";';

const at = new Date('2026-10-06T00:00:00.000Z');
const EMPTY: SchemaDescription = { tables: [] };

/** What `x db gen` does the second time: the sidecar on disk, read back through its own parser. */
function roundTrip(snapshot: SchemaDescription): SchemaDescription {
  const parsed = parseSnapshot(JSON.parse(snapshotJson(snapshot)));
  if (parsed === undefined) expect.unreachable('the generator wrote a snapshot it cannot parse');
  return parsed;
}

const generate = (entities: readonly EntityDescriptionLike[], current: SchemaDescription) =>
  generateMigration({ entities, current, name: 'ledger', now: at });

describe('appendOnly · the trigger SQL (golden)', () => {
  test('the function and trigger are the exact bytes every migration carries', () => {
    expect(APPEND_ONLY_FUNCTION).toBe('ultimate_refuse_append_only');
    expect(APPEND_ONLY_TRIGGER).toBe('ultimate_append_only');
    expect(APPEND_ONLY_FUNCTION_SQL).toBe(
      'create or replace function "ultimate_refuse_append_only"() returns trigger ' +
        'language plpgsql as $append_only$ begin raise exception ' +
        "'X_ENTITY_APPEND_ONLY: % on %.% is refused, the table is append-only', " +
        'tg_op, tg_table_schema, tg_table_name using errcode = ' +
        "'23001', hint = 'insert a new row instead; to allow rewrites, remove appendOnly from the " +
        "entity and run x db gen'; end; $append_only$;",
    );
    expect(appendOnlyTriggerSql('ledger')).toBe(
      'create trigger "ultimate_append_only" before update or delete on "ledger" ' +
        'for each row execute function "ultimate_refuse_append_only"();',
    );
  });
});

describe('appendOnly · x db gen', () => {
  test('a new append-only table is created, then the function, then its trigger', () => {
    const migration = generate([entity('ledger', true)], EMPTY);
    const up = migration.up.split('\n');
    const create = up.findIndex((line) => line.startsWith('create table "ledger"'));
    const fn = up.indexOf(APPEND_ONLY_FUNCTION_SQL);
    const trigger = up.indexOf(appendOnlyTriggerSql('ledger'));
    expect(create).toBeGreaterThanOrEqual(0);
    expect(fn).toBeGreaterThan(create);
    expect(trigger).toBeGreaterThan(fn);
    // A table this migration creates is dropped by its own `down`, trigger and all.
    expect(migration.down).not.toContain('drop trigger');
    expect(findTable(migration.snapshot, 'ledger')?.appendOnly).toBe(true);
    expect(migration.destructive).toBe(false);
  });

  test('an entity that never says appendOnly gains no trigger and no snapshot key', () => {
    const migration = generate([entity('notes'), entity('drafts', false)], EMPTY);
    expect(migration.up).not.toContain('trigger');
    expect(migration.up).not.toContain(APPEND_ONLY_FUNCTION);
    expect(snapshotJson(migration.snapshot)).not.toContain('appendOnly');
  });

  test('the second x db gen is an empty diff — the snapshot carries the fact through its parser', () => {
    const first = generate([entity('ledger', true)], EMPTY);
    const second = generate([entity('ledger', true)], roundTrip(first.snapshot));
    expect(second.up).toBe('');
    expect(second.down).toBe('');
  });

  test('turning it on for an existing table adds the trigger, and down drops exactly it', () => {
    const before = roundTrip(generate([entity('ledger')], EMPTY).snapshot);
    const migration = generate([entity('ledger', true)], before);
    // Drop-if-exists first: a disabled trigger of the same name would make a bare create fail.
    expect(migration.up).toBe(
      `${APPEND_ONLY_FUNCTION_SQL}\n${DROP_LEDGER}\n${appendOnlyTriggerSql('ledger')}`,
    );
    expect(migration.down).toBe(DROP_LEDGER);
    expect(destructiveStatements(migration.up)).toEqual([]);
  });

  test('turning it off drops the trigger, and down puts it back', () => {
    const before = roundTrip(generate([entity('ledger', true)], EMPTY).snapshot);
    const migration = generate([entity('ledger')], before);
    expect(migration.up).toBe(DROP_LEDGER);
    expect(migration.down).toBe(
      `${APPEND_ONLY_FUNCTION_SQL}\n${DROP_LEDGER}\n${appendOnlyTriggerSql('ledger')}`,
    );
    expect(findTable(migration.snapshot, 'ledger')?.appendOnly).toBeUndefined();
  });

  test('two append-only tables in one migration define the function once', () => {
    const migration = generate([entity('ledger', true), entity('events', true)], EMPTY);
    const definitions = migration.up.split(APPEND_ONLY_FUNCTION_SQL).length - 1;
    expect(definitions).toBe(1);
    expect(migration.up).toContain(appendOnlyTriggerSql('ledger'));
    expect(migration.up).toContain(appendOnlyTriggerSql('events'));
  });

  test('a snapshot carrying appendOnly: false is read as absent, anything else refuses the file', () => {
    const tables = (value: unknown) => ({
      tables: [
        {
          schema: 'public',
          name: 'ledger',
          columns: [],
          primaryKey: [],
          indexes: [],
          foreignKeys: [],
          appendOnly: value,
        },
      ],
    });
    expect(parseSnapshot(tables(false))?.tables[0]).not.toHaveProperty('appendOnly');
    expect(parseSnapshot(tables(true))?.tables[0]?.appendOnly).toBe(true);
    expect(parseSnapshot(tables('yes'))).toBeUndefined();
  });
});
