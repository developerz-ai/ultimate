// `missing-check` against a real catalog. Two halves, and the second is the one a fake cannot
// prove: that a CORRECT database is silent even though Postgres has rewritten every predicate the
// migration declared. This file reads `pg_constraint` through `introspectSchema()` and compares the
// answer with a snapshot `snapshotOf` produced, which is exactly what `checkDrift` does after
// `ROLE=migrate`.
//
// Every table here is dropped on the way in and on the way out; nothing is left behind.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type PostgresClient, postgresClient } from './client';
import { appTables, diffSchema } from './drift';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration, snapshotOf } from './generate';
import { introspectSchema, type SchemaDescription } from './introspect';
import { raw } from './sql';
import { statementsOf } from './statement-split';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const TABLE = 'dchk_posts';
const SCHEMA = 'dchk_schema';

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

/** `status in (…)` is the spelling that comes back as `= ANY (ARRAY[…])` — the whole point. */
const entity: EntityDescriptionLike = {
  name: 'DchkPost',
  table: TABLE,
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
    column('status', { notNull: true, check: "status in ('draft', 'published')" }),
  ],
  indexes: [],
  invariants: [
    {
      name: 'title_present',
      kind: 'check',
      message: 'title present',
      sql: 'char_length(btrim(id::text)) >= 1',
      where: null,
    },
  ],
};

const at = new Date('2026-08-25T00:00:00.000Z');

/**
 * The search_path rides on the CONNECTION STRING, never on a `set search_path` statement: this
 * client is a pool, so a `SET` lands on whichever connection served it and the next unqualified
 * statement runs somewhere else. `libpq-options.ts` keeps an operator's own `options` flags, which
 * is what makes this work at all.
 */
const scopedUrl = (base: string): string => {
  const parsed = new URL(base);
  parsed.searchParams.set('options', `-c search_path=${SCHEMA}`);
  return parsed.toString();
};

describe.skipIf(!hasPostgres)('live · postgres · a CHECK the catalog no longer holds', () => {
  let admin: PostgresClient;
  let client: PostgresClient;
  let declared: SchemaDescription;

  const live = async (): Promise<SchemaDescription> =>
    appTables(await introspectSchema({ client, schema: SCHEMA }));

  beforeAll(async () => {
    // Its own schema, so `introspectSchema()` sees this table and nothing else the server is holding.
    admin = postgresClient({ url: url ?? '' });
    await admin.execute(raw(`drop schema if exists "${SCHEMA}" cascade`));
    await admin.execute(raw(`create schema "${SCHEMA}"`));
    client = postgresClient({ url: scopedUrl(url ?? '') });
    declared = snapshotOf([entity]);
    for (const statement of statementsOf(
      generateMigration({ entities: [entity], name: 'init', now: at }).up,
    )) {
      await client.execute(raw(statement));
    }
  });

  afterAll(async () => {
    await client.close();
    await admin.execute(raw(`drop schema if exists "${SCHEMA}" cascade`));
    await admin.close();
  });

  test('the catalog really does rewrite the predicate this migration declared', async () => {
    // The premise the name-only read rests on. If these two strings were ever equal, `checks` could
    // have been filled from the catalog and none of this would be needed.
    const rows = await client.query<{ def: string }>(
      raw(
        `select pg_get_constraintdef(c.oid) as def from pg_constraint c ` +
          `join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace ` +
          `where n.nspname = '${SCHEMA}' and t.relname = '${TABLE}' ` +
          `and c.conname = '${TABLE}_status_check'`,
      ),
    );
    expect(rows[0]?.def ?? '').toBe(
      "CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text])))",
    );
    expect(rows[0]?.def ?? '').not.toContain("status in ('draft', 'published')");
  });

  test('a database that is exactly right is SILENT, rewriting and all', async () => {
    const report = diffSchema(await live(), declared);
    expect(report.differences).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test('a constraint dropped by hand is `missing-check`, with the statement as its fix', async () => {
    // What an agent does: `alter table … drop constraint` in a psql session, and every later write
    // accepted whatever the app did not stop. Nothing read `pg_constraint`, so this was `ok: true`.
    await client.execute(
      raw(`alter table "${SCHEMA}"."${TABLE}" drop constraint "${TABLE}_status_check"`),
    );
    const report = diffSchema(await live(), declared);
    expect(report.ok).toBe(false);
    expect(report.differences.map((difference) => difference.kind)).toEqual(['missing-check']);
    expect(report.differences[0]?.cause).toBe(
      `table "${TABLE}" is missing check constraint "${TABLE}_status_check" that migrations declare`,
    );
    expect(report.differences[0]?.fix).toBe(
      // The table lives outside the default schema, so the statement is told where to look.
      `psql "$DATABASE_URL" -c 'set search_path = "${SCHEMA}"; alter table "${TABLE}" add ` +
        `constraint "${TABLE}_status_check" ` +
        `check (status in ('\\''draft'\\'', '\\''published'\\''));'   ` +
        '# then x db migrate, which re-checks',
    );
  });

  test('and the fix is a COMMAND that runs — after it, the report is clean again', async () => {
    const [difference] = diffSchema(await live(), declared).differences;
    const fix = difference?.fix ?? '';
    if (Bun.which('psql') !== null) {
      // As written, through a real shell: the line is one command, and its quoting is the shell's.
      const shell = Bun.spawn(['sh', '-c', fix], {
        // The PLAIN url and no `PGOPTIONS`: nothing but the fix itself may put this schema on the
        // search_path, which is the whole claim.
        env: { ...Bun.env, DATABASE_URL: url ?? '', PGOPTIONS: '' },
        stdout: 'ignore',
        stderr: 'pipe',
      });
      const said = await new Response(shell.stderr).text();
      expect([await shell.exited, said]).toEqual([0, '']);
    } else {
      // No psql on this machine: the statement it would be handed, the shell's quoting undone.
      const word = /^psql "\$DATABASE_URL" -c 'set search_path = "[a-z_]+"; (.*)' {3}# /s.exec(
        fix,
      )?.[1];
      expect(word).toBeDefined();
      await client.execute(raw((word ?? '').replaceAll(`'\\''`, `'`)));
    }
    expect(diffSchema(await live(), declared).ok).toBe(true);
  });

  test('a constraint the catalog holds and no migration declares stays silent', async () => {
    await client.execute(
      raw(`alter table "${SCHEMA}"."${TABLE}" add constraint "dba_added" check (id is not null)`),
    );
    expect(diffSchema(await live(), declared).ok).toBe(true);
  });
});
