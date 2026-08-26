// Which columns a script retypes, read off the SQL — the input to the view preflight, and the half
// that runs with no database. Both directions are pinned: a target MISSED is the server's own
// `0A000` one statement later (which is what happened before the preflight existed), and a target
// INVENTED is a catalog read and a refusal on a migration that would have applied.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { refuseDependentViews, retypeTargets } from './dependent-view';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { createRecordingClient } from './fake';
import { generateMigration, snapshotOf } from './generate';

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

const docs = (kind: string): EntityDescriptionLike => ({
  name: 'Doc',
  table: 'docs',
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
    column('rank', { kind }),
  ],
  indexes: [],
});

describe('retypeTargets', () => {
  // Against the generator's own output rather than a hand-typed statement: the preflight exists to
  // read what `x db gen` writes, and a matcher pinned to a spelling nobody emits protects nothing.
  test('reads the retype this repo actually emits', () => {
    const up = generateMigration({
      entities: [docs('text')],
      current: snapshotOf([docs('integer')]),
      name: 'rank to text',
      now: new Date(0),
    }).up;
    expect(retypeTargets(up)).toEqual([{ table: 'docs', column: 'rank' }]);
  });

  test('the COLUMN keyword is optional, and a bare name folds to lower case', () => {
    expect(retypeTargets('alter table Docs alter Rank type text;')).toEqual([
      { table: 'docs', column: 'rank' },
    ]);
  });

  test('a quoted name keeps its case, because that is the name the catalog holds', () => {
    expect(retypeTargets('alter table "Docs" alter column "Rank" type text;')).toEqual([
      { table: 'Docs', column: 'Rank' },
    ]);
  });

  // A quoted name is a NAME. `alter table "t" alter "column" type text` retypes a column called
  // `column`; read as the keyword it would name `type` instead and match nothing at all.
  test('a column named after a keyword is still the column', () => {
    expect(retypeTargets('alter table "t" alter "column" type text;')).toEqual([
      { table: 't', column: 'column' },
    ]);
  });

  test('two retypes in one statement are two targets', () => {
    expect(
      retypeTargets('alter table "t" alter column "a" type text, alter column "b" type text;'),
    ).toEqual([
      { table: 't', column: 'a' },
      { table: 't', column: 'b' },
    ]);
  });

  // Both spellings sit INSIDE an `alter table` statement on purpose. A retype written in a comment
  // or a literal at the top of some other statement is refused by the first token and proves
  // nothing about the lexer; here the scan reaches them, and reading either as code invents a
  // target on a column the statement never touches.
  test('a retype inside a comment is prose, and one inside a literal is data', () => {
    expect(
      retypeTargets(
        'alter table "t"\n  -- alter column "d" type text\n  alter column "c" set not null;',
      ),
    ).toEqual([]);
    expect(
      retypeTargets(`alter table "t" alter column "c" set default 'alter column "d" type text';`),
    ).toEqual([]);
  });

  test('every other alter is not one — a false target refuses a migration that would apply', () => {
    expect(retypeTargets('alter table "t" add column "c" text;')).toEqual([]);
    expect(retypeTargets('alter table "t" alter column "c" set not null;')).toEqual([]);
    expect(retypeTargets('alter table "t" drop constraint "k";')).toEqual([]);
    expect(retypeTargets('create index "i" on "t" ("c");')).toEqual([]);
  });
});

describe('the fix line', () => {
  const up = generateMigration({
    entities: [docs('text')],
    current: snapshotOf([docs('integer')]),
    name: 'rank to text',
    now: new Date(0),
  }).up;

  /** The refusal `refuseDependentViews` raises for one catalog row, with nothing real connected. */
  const refuse = async (
    definition: string,
    view = 'docs_published',
    relkind = 'v',
  ): Promise<UltimateError> => {
    const client = createRecordingClient().on(/pg_depend/, {
      rows: [{ view_name: view, table_name: 'docs', column_name: 'rank', definition, relkind }],
    });
    const failure = await refuseDependentViews(client, up).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(UltimateError);
    return failure as UltimateError;
  };

  /**
   * The `-c` argument as a POSIX shell actually reads it. `printf` and not `psql`, because the
   * question is the QUOTING and nothing here has a server: a fix line that is one argv word to
   * `psql` is one argv word to any program.
   */
  const shellReads = async (invocation: string): Promise<string> => {
    const argument = invocation.replace('psql "$DATABASE_URL" -c ', "printf '%s' ");
    const shell = Bun.spawn(['sh', '-c', argument], { stdout: 'pipe', stderr: 'pipe' });
    const [out, code] = await Promise.all([new Response(shell.stdout).text(), shell.exited]);
    expect(code).toBe(0);
    return out;
  };

  // The shape it had until 2026-08-25: `drop view "v";   # then x db migrate, then: create …`.
  // `#` is not a comment in Postgres, so psql read the whole line and failed on it; a shell read
  // `drop` as a program that does not exist. Runnable by neither reader is axiom 4 unmet.
  test('both halves are psql invocations, never bare DDL', async () => {
    const error = await refuse('SELECT id, rank FROM docs;');
    expect(error.fix).toStartWith('psql "$DATABASE_URL" -c ');
    expect(error.fix).toContain(`psql "$DATABASE_URL" -c 'drop view "docs_published"'`);
    expect(error.fix).toContain(
      `psql "$DATABASE_URL" -c 'create view "docs_published" as SELECT id, rank FROM docs'`,
    );
    // The view, the table and the column still reach the operator: that is what the code is for.
    expect(error.cause).toContain('docs_published');
    expect(error.cause).toContain('docs');
    expect(error.cause).toContain('rank');
  });

  // `pg_get_viewdef` pretty-prints across lines and ends in a `;`; a `fix:` is read as a command.
  test('the recovered definition is collapsed onto one line', async () => {
    const error = await refuse(' SELECT id,\n    rank\n   FROM docs;');
    expect(error.fix).toContain(`create view "docs_published" as SELECT id, rank FROM docs'`);
    expect(error.fix).not.toContain('\n');
  });

  // The half a hand-written escape gets wrong. A view definition carries the server's own text,
  // and `where status = 'published'` is a quote inside the word the shell is being handed.
  test("a ' in the definition survives the shell, so the statement arrives whole", async () => {
    const definition = `SELECT id, rank FROM docs WHERE status = 'published';`;
    const error = await refuse(definition);
    const create = error.fix.slice(error.fix.lastIndexOf('psql "$DATABASE_URL" -c '));
    expect(await shellReads(create)).toBe(
      `create view "docs_published" as SELECT id, rank FROM docs WHERE status = 'published'`,
    );
  });

  test('the drop half survives the same shell, one argv word', async () => {
    const error = await refuse('SELECT id, rank FROM docs;');
    const drop = error.fix.slice(0, error.fix.indexOf('   #'));
    expect(await shellReads(drop)).toBe('drop view "docs_published"');
  });

  // `identifier()` refuses a name holding a quote, a space or a backslash — all three legal inside
  // a quoted Postgres name — and a `fix:` may not throw. The degraded line still LEADS with a
  // command that runs, and still carries the definition, so nothing has to be reconstructed.
  test('a name identifier() refuses degrades to a session, never to an exception', async () => {
    const error = await refuse('SELECT id, rank FROM docs;', 'my "odd" view');
    expect(error.fix).toStartWith('psql "$DATABASE_URL"');
    expect(error.fix).toContain('my \\"odd\\" view');
    expect(error.fix).toContain('SELECT id, rank FROM docs');
  });

  /**
   * `dependentViews` selects `relkind in ('v', 'm')` on purpose — a matview carries the same
   * `_RETURN` rule and fails the same `0A000`. But Postgres refuses `drop view` on one
   * (WRONG_OBJECT_TYPE, "use DROP MATERIALIZED VIEW"), so before 2026-08-26 the one kind the
   * query went out of its way to include was the one whose fix could not run.
   */
  test('a MATERIALISED view gets materialized-view DDL, both halves', async () => {
    const failure = await refuse('SELECT id, rank FROM docs', 'docs_ranked', 'm');
    expect(failure.fix).toContain('drop materialized view "docs_ranked"');
    expect(failure.fix).toContain('create materialized view "docs_ranked" as');
    // Never the plain spelling anywhere in the line — a stray `drop view` is the bug returning.
    expect(failure.fix).not.toMatch(/(?:^|[^d] )drop view /);
  });

  test('a matview fix says its indexes are not carried — the recreate is not complete', async () => {
    const failure = await refuse('SELECT id, rank FROM docs', 'docs_ranked', 'm');
    expect(failure.fix).toContain('re-create its indexes');
  });

  test('an ordinary view is unchanged by the matview branch', async () => {
    const failure = await refuse('SELECT id, rank FROM docs', 'docs_published', 'v');
    expect(failure.fix).toContain('drop view "docs_published"');
    expect(failure.fix).not.toContain('materialized');
    expect(failure.fix).not.toContain('re-create its indexes');
  });

  test('the quoted-name fallback carries the kind too', async () => {
    const failure = await refuse('SELECT id FROM docs', 'has space', 'm');
    expect(failure.fix).toContain('drop materialized view <name>');
    expect(failure.fix).toContain('create materialized view <name> as');
  });
});
