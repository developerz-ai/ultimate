// The one proof of the append-only trigger, run against a real server by two suites: Postgres
// (`generate-append-only.live.test.ts`) and the embedded PGlite (`generate-append-only-embedded`).
// The repository's refusal is entity's; this is the half that holds when nobody uses the repository.

import { expect } from 'bun:test';
import { renderThrowable } from '@ultimat3/core';
import type { DbClient } from './client';
import { diffSchema } from './drift';
import type { EntityDescriptionLike } from './entity-shape';
import { generateMigration } from './generate';
import { APPEND_ONLY_TRIGGER } from './generate-append-only';
import { introspect, type SchemaDescription } from './introspect';
import { raw } from './sql';
import { sqlState } from './sqlstate';
import { statementsOf } from './statement-split';

const describeLedger = (table: string, appendOnly: boolean): EntityDescriptionLike => ({
  name: table,
  table,
  primaryKey: ['id'],
  columns: [
    {
      property: 'id',
      column: 'id',
      kind: 'integer',
      notNull: true,
      primaryKey: true,
      unique: false,
      hasDefault: false,
      check: null,
      references: null,
    },
    {
      property: 'body',
      column: 'body',
      kind: 'text',
      notNull: true,
      primaryKey: false,
      unique: false,
      hasDefault: false,
      check: null,
      references: null,
    },
  ],
  indexes: [],
  appendOnly,
});

/** The failure a statement rejected with, as the fixture asserts on it: its text and its state. */
async function refusal(
  send: Promise<unknown>,
): Promise<{ text: string; state: string | undefined }> {
  try {
    await send;
  } catch (error) {
    const source = (error as { sourceError?: unknown }).sourceError ?? error;
    return {
      text: `${renderThrowable(error)} ${renderThrowable(source)}`,
      state: sqlState(source),
    };
  }
  return expect.unreachable('the append-only table accepted a write that rewrites a row');
}

/**
 * The SQL inside a finding's `psql "$DATABASE_URL" -c '…'   # …` fix, exactly as a shell would hand
 * it to psql: the single-quoted word, with its `'\\''` escapes undone.
 */
function printedRepair(fix: string): string {
  const match = /^psql "\$DATABASE_URL" -c '((?:[^']|'\\'')*)'/.exec(fix);
  if (match?.[1] === undefined) return expect.unreachable(`the fix is no psql -c command: ${fix}`);
  return match[1].replaceAll(`'\\''`, "'");
}

export async function proveAppendOnlyTrigger(client: DbClient, table: string): Promise<void> {
  const apply = async (script: string): Promise<void> => {
    for (const statement of statementsOf(script)) await client.execute(raw(statement));
  };
  const one = (schema: SchemaDescription): SchemaDescription => ({
    tables: schema.tables.filter((each) => each.name === table),
  });
  const drift = async (expected: SchemaDescription) =>
    diffSchema(one(await introspect({ client })), expected).differences.map((d) => d.kind);

  await client.execute(raw(`drop table if exists "${table}"`));
  const migration = generateMigration({
    entities: [describeLedger(table, true)],
    name: 'ledger',
    now: new Date('2026-10-06T00:00:00.000Z'),
  });
  await apply(migration.up);

  await client.execute(raw(`insert into "${table}" (id, body) values (1, 'first')`));
  // Appending is the one thing the table is for.
  await client.execute(raw(`insert into "${table}" (id, body) values (2, 'second')`));

  for (const statement of [
    `update "${table}" set body = 'rewritten' where id = 1`,
    `delete from "${table}" where id = 1`,
    `insert into "${table}" (id, body) values (1, 'again') on conflict (id) do update set body = excluded.body`,
  ]) {
    const refused = await refusal(client.execute(raw(statement)));
    expect(refused.text).toContain('X_ENTITY_APPEND_ONLY');
    expect(refused.text).toContain(`on public.${table} is refused`);
    expect(refused.state).toBe('23001');
  }
  const rows = await client.query<{ body: string }>(raw(`select body from "${table}" order by id`));
  expect(rows.map((row) => row.body)).toEqual(['first', 'second']);

  // The catalog holds it, and drift agrees with the snapshot.
  expect(one(await introspect({ client })).tables[0]?.triggerNames).toContain(APPEND_ONLY_TRIGGER);
  expect(await drift(migration.snapshot)).toEqual([]);

  // Disabled is as good as gone: an ordinary session fires nothing. The finding's PRINTED repair,
  // run as written, must restore the refusal from both states — a disabled trigger still exists,
  // so a repair that only `create`d would fail on it and leave the table unprotected.
  for (const breakIt of [
    `alter table "${table}" disable trigger "${APPEND_ONLY_TRIGGER}"`,
    `drop trigger "${APPEND_ONLY_TRIGGER}" on "${table}"`,
  ]) {
    await client.execute(raw(breakIt));
    await client.execute(raw(`update "${table}" set body = 'unguarded' where id = 2`));
    const found = diffSchema(one(await introspect({ client })), migration.snapshot).differences;
    expect(found.map((difference) => difference.kind)).toEqual(['missing-append-only-trigger']);
    await apply(printedRepair(found[0]?.fix ?? ''));
    expect(await drift(migration.snapshot)).toEqual([]);
    await refusal(client.execute(raw(`delete from "${table}" where id = 2`)));
  }

  // Turning appendOnly off is a migration that drops the trigger; the rows move again.
  const off = generateMigration({
    entities: [describeLedger(table, false)],
    current: migration.snapshot,
    name: 'ledger mutable',
    now: new Date('2026-10-06T00:00:01.000Z'),
  });
  await apply(off.up);
  await client.execute(raw(`update "${table}" set body = 'edited' where id = 1`));
  // …and its `down` puts the refusal back.
  await apply(off.down);
  await refusal(client.execute(raw(`update "${table}" set body = 'edited twice' where id = 1`)));

  await client.execute(raw(`drop table "${table}"`));
}
