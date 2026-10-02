// Single responsibility: `unexpected-object` — what a live database holds that replaying the
// migrations does not create, compared by identity, with a fix that is one command a shell runs.

import { describe, expect, test } from 'bun:test';
import { type CatalogDescription, emptyCatalog } from './catalog';
import { driftError } from './drift';
import { unexpectedObjects } from './object-drift';

const trigger = (table: string, name: string) => ({
  table,
  name,
  definition: `CREATE TRIGGER ${name} BEFORE UPDATE ON public.${table} FOR EACH ROW EXECUTE FUNCTION touch()`,
  enabled: 'O',
});

const fn = (name: string, args = '') => ({
  name,
  arguments: args,
  definition: `CREATE OR REPLACE FUNCTION public.${name}(${args})`,
});

const catalog = (overrides: Partial<CatalogDescription>): CatalogDescription => ({
  ...emptyCatalog(),
  ...overrides,
});

describe('unexpectedObjects', () => {
  test('a hand-created trigger with no migration is reported, as X_DB_DRIFT', () => {
    const expected = catalog({ functions: [fn('touch')] });
    const live = catalog({ functions: [fn('touch')], triggers: [trigger('posts', 'posts_touch')] });
    const [difference, ...rest] = unexpectedObjects(live, expected);
    expect(rest).toEqual([]);
    expect(difference).toEqual({
      kind: 'unexpected-object',
      table: 'posts',
      column: null,
      cause:
        'trigger "posts_touch" on table "posts" exists in this database and no migration creates it',
      // ONE command a shell runs, and the harmless one: it prints the definition a migration
      // would need, which a drop-first line destroyed before anyone could copy it.
      fix:
        `psql "$DATABASE_URL" -c '\\d "posts"'   # no migration creates it: copy its definition ` +
        'into a migration as a create statement, run drop trigger "posts_touch" on "posts"; ' +
        'here, then x db migrate — or only drop it if nothing owns it',
    });
    expect(driftError(difference ?? expect.unreachable()).code).toBe('X_DB_DRIFT');
  });

  test('every table-less kind is compared, each under the word drop takes', () => {
    const live = catalog({
      types: [{ kind: 'enum', name: 'mood', labels: ['ok'] }],
      sequences: [
        {
          name: 'ticket_seq',
          dataType: 'bigint',
          start: '1',
          increment: '1',
          min: '1',
          max: '9',
          cache: '1',
          cycle: false,
        },
      ],
      views: [
        { name: 'report', materialized: false, options: null, definition: 'SELECT 1;' },
        { name: 'totals', materialized: true, options: null, definition: 'SELECT 1;' },
      ],
      functions: [fn('add', 'a integer, b integer')],
    });
    expect(unexpectedObjects(live, emptyCatalog()).map((difference) => difference.cause)).toEqual([
      'type "mood" exists in this database and no migration creates it',
      'sequence "ticket_seq" exists in this database and no migration creates it',
      'view "report" exists in this database and no migration creates it',
      'materialized view "totals" exists in this database and no migration creates it',
      'function "add"(a integer, b integer) exists in this database and no migration creates it',
    ]);
  });

  test('identity, never text: a definition the two servers spell differently is not drift', () => {
    const expected = catalog({ triggers: [trigger('posts', 'posts_touch')] });
    const live = catalog({
      triggers: [{ ...trigger('posts', 'posts_touch'), definition: 'another spelling' }],
    });
    expect(unexpectedObjects(live, expected)).toEqual([]);
  });

  test('an overload the migrations do not create is its own object', () => {
    const expected = catalog({ functions: [fn('add', 'a integer')] });
    const live = catalog({ functions: [fn('add', 'a integer'), fn('add', 'a text')] });
    const [difference, ...rest] = unexpectedObjects(live, expected);
    expect(rest).toEqual([]);
    // `drop function "add";` is `42725 function name is not unique` while both live: the fix
    // names the overload it means.
    expect(difference?.fix).toContain(
      `pg_get_function_identity_arguments(oid) = '\\''a text'\\'''`,
    );
    expect(difference?.fix).toContain('run drop function "add"(a text); here');
  });

  test('a function with no arguments is dropped by its empty list', () => {
    const [difference] = unexpectedObjects(catalog({ functions: [fn('touch')] }), emptyCatalog());
    expect(difference?.fix).toStartWith(
      `psql "$DATABASE_URL" -c 'select pg_get_functiondef(oid) from pg_proc where `,
    );
    expect(difference?.fix).toContain('run drop function "touch"(); here');
  });

  test('a signature no statement can spell is left out of the fix, never escaped into it', () => {
    const live = catalog({ functions: [fn('add', 'a "$(id)"')] });
    const [difference] = unexpectedObjects(live, emptyCatalog());
    expect(difference?.fix).not.toContain('$(id)');
    expect(difference?.fix).toStartWith('psql "$DATABASE_URL"   # ');
  });

  test('each kind is shown by the psql command that prints its definition', () => {
    const live = catalog({
      types: [{ kind: 'enum', name: 'mood', labels: ['ok'] }],
      views: [
        { name: 'report', materialized: false, options: null, definition: 'SELECT 1;' },
        { name: 'totals', materialized: true, options: null, definition: 'SELECT 1;' },
      ],
    });
    const head = (fix: string): string => fix.split('   # ')[0] ?? '';
    expect(unexpectedObjects(live, emptyCatalog()).map((one) => head(one.fix))).toEqual([
      `psql "$DATABASE_URL" -c '\\dT+ "mood"'`,
      `psql "$DATABASE_URL" -c '\\d+ "report"'`,
      `psql "$DATABASE_URL" -c '\\d+ "totals"'`,
    ]);
  });

  test("a ' in the arguments stays inside psql's one shell word, and out of the comment", async () => {
    const live = catalog({ functions: [fn('add', `a text DEFAULT 'x'::text`)] });
    const fix = unexpectedObjects(live, emptyCatalog())[0]?.fix ?? '';
    const head = 'psql "$DATABASE_URL" -c ';
    const probe = Bun.spawn(['sh', '-c', fix.replace(head, 'printf "%s|" ')], { stdout: 'pipe' });
    // One word, and the SQL in it quotes the value twice over: `'x'` is `''x''` inside a literal.
    expect(await new Response(probe.stdout).text()).toBe(
      'select pg_get_functiondef(oid) from pg_proc where pg_function_is_visible(oid) and ' +
        `proname = 'add' and pg_get_function_identity_arguments(oid) = ` +
        `'a text DEFAULT ''x''::text'|`,
    );
    expect(fix.split('   # ')[1]).not.toContain("'");
  });

  test('one direction: an object the database lacks is the ledger’s to report', () => {
    expect(unexpectedObjects(emptyCatalog(), catalog({ functions: [fn('touch')] }))).toEqual([]);
  });

  test('framework bookkeeping is not app schema', () => {
    const live = catalog({
      triggers: [trigger('x_jobs', 'x_jobs_notify')],
      functions: [fn('x_notify')],
    });
    expect(unexpectedObjects(live, emptyCatalog())).toEqual([]);
  });

  test('a name no statement can spell is left out of the fix, never escaped into it', () => {
    const live = catalog({ functions: [fn('$(id)')] });
    const [difference] = unexpectedObjects(live, emptyCatalog());
    expect(difference?.fix).not.toContain('$(id)');
    expect(difference?.fix).toStartWith('psql "$DATABASE_URL"   # ');
    expect(difference?.cause).toContain('$(id)');
  });
});
