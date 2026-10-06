// An `appendOnly` table whose trigger is gone is drift with its own code: the guarantee the entity
// declares is no longer held by the database, and nothing else would say so — the repository still
// refuses, so every test above the driver stays green while raw SQL rewrites the ledger.

import { describe, expect, test } from 'bun:test';
import { diffSchema, driftError } from './drift';
import { APPEND_ONLY_DRIFT_CODE } from './drift-append-only';
import { APPEND_ONLY_FUNCTION_SQL, APPEND_ONLY_TRIGGER } from './generate-append-only';
import type { SchemaDescription, TableDescription } from './introspect';

const table = (overrides: Partial<TableDescription> = {}): TableDescription => ({
  schema: 'public',
  name: 'ledger',
  columns: [{ name: 'id', dataType: 'uuid', nullable: false, default: null, position: 1 }],
  primaryKey: ['id'],
  indexes: [
    { name: 'ledger_pkey', columns: ['id'], unique: true, primary: true, where: null, order: null },
  ],
  foreignKeys: [],
  ...overrides,
});

const schema = (one: TableDescription): SchemaDescription => ({ tables: [one] });
const declared = schema(table({ appendOnly: true }));

describe('appendOnly · drift', () => {
  test('the trigger present and enabled is agreement', () => {
    const live = schema(table({ triggerNames: [APPEND_ONLY_TRIGGER] }));
    expect(diffSchema(live, declared)).toEqual({ ok: true, differences: [] });
  });

  test('the trigger missing is missing-append-only-trigger, raised as its own code', () => {
    const live = schema(table({ triggerNames: ['audit_stamp'] }));
    const report = diffSchema(live, declared);
    expect(report.ok).toBe(false);
    expect(report.differences.map((difference) => difference.kind)).toEqual([
      'missing-append-only-trigger',
    ]);
    const difference = report.differences[0];
    if (difference === undefined) expect.unreachable('a missing trigger was not reported');
    expect(difference.cause).toContain('"ledger"');
    expect(difference.cause).toContain(APPEND_ONLY_TRIGGER);
    // The repair is the statement itself, against this database: the migration is in the ledger.
    expect(difference.fix).toStartWith(`psql "$DATABASE_URL" -c '`);
    // Drop-if-exists BEFORE create: a disabled trigger is reported here yet still exists.
    expect(difference.fix).toContain(
      'drop trigger if exists "ultimate_append_only" on "ledger"; ' +
        'create trigger "ultimate_append_only" before update or delete',
    );
    expect(difference.fix).toContain(`${APPEND_ONLY_FUNCTION_SQL.replaceAll("'", `'\\''`)}`);
    const error = driftError(difference);
    expect(error.code).toBe(APPEND_ONLY_DRIFT_CODE);
    expect(error.meta).toEqual({
      kind: 'missing-append-only-trigger',
      table: 'ledger',
      column: null,
    });
  });

  test('a table outside public carries its search_path into the repair', () => {
    const live = schema(table({ schema: 'tenant_a', triggerNames: [] }));
    const [difference] = diffSchema(
      live,
      schema(table({ schema: 'tenant_a', appendOnly: true })),
    ).differences;
    expect(difference?.fix).toContain('set search_path = "tenant_a"; ');
  });

  test('a name no statement can spell degrades the fix to a session, never an escape', () => {
    const name = 'led$(id)ger';
    const live = schema(table({ name, triggerNames: [] }));
    const [difference] = diffSchema(live, schema(table({ name, appendOnly: true }))).differences;
    expect(difference?.fix).toStartWith('psql "$DATABASE_URL"   #');
    expect(difference?.fix).not.toContain(name);
  });

  test('a description that never asked the catalog reports nothing', () => {
    expect(diffSchema(schema(table()), declared).ok).toBe(true);
  });

  test('a table that does not declare it is never judged, whatever triggers it holds', () => {
    const live = schema(table({ triggerNames: [] }));
    expect(diffSchema(live, schema(table())).ok).toBe(true);
  });

  test('every other drift kind keeps X_DB_DRIFT', () => {
    const live = schema(table({ columns: [] }));
    const [difference] = diffSchema(live, schema(table())).differences;
    if (difference === undefined) expect.unreachable('a missing column was not reported');
    expect(driftError(difference).code).toBe('X_DB_DRIFT');
  });
});
