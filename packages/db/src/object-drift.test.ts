// Single responsibility: `unexpected-object` — what a live database holds that replaying the
// migrations does not create, compared by identity, with a fix that drops before it re-creates.

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
      fix:
        'run drop trigger "posts_touch" on "posts"; inside psql "$DATABASE_URL", then write its ' +
        'create statement into a migration and run x db migrate — or leave it dropped if nothing ' +
        'owns it',
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
    expect(difference?.fix).toStartWith('run drop function "add"(a text); inside psql');
  });

  test('a function with no arguments is dropped by its empty list', () => {
    const [difference] = unexpectedObjects(catalog({ functions: [fn('touch')] }), emptyCatalog());
    expect(difference?.fix).toStartWith('run drop function "touch"(); inside psql');
  });

  test('a signature no statement can spell is left out of the fix, never escaped into it', () => {
    const live = catalog({ functions: [fn('add', 'a "$(id)"')] });
    const [difference] = unexpectedObjects(live, emptyCatalog());
    expect(difference?.fix).not.toContain('$(id)');
    expect(difference?.fix).toStartWith('drop it by hand');
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
    expect(difference?.fix).toStartWith('drop it by hand');
    expect(difference?.cause).toContain('$(id)');
  });
});
