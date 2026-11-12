// The storage declaration as text: what `createTableDdl` renders for the boot's `;` split, which
// declarations are refused before they reach DDL, and what drift says against a catalog row.

import { describe, expect, test } from 'bun:test';
import { DbError } from './errors';
import { createTableDdl, storageAlters, tableStorage, tableStorageDrift } from './table-storage';

const HOT = tableStorage('x_rate_limit', { fillfactor: 70, unlogged: true });

describe('createTableDdl', () => {
  test('an unlogged fillfactor table is created that way and re-applied to an existing one', () => {
    const ddl = createTableDdl(HOT, '\n  key text primary key,\n  n int not null\n');
    expect(ddl).toBe(
      [
        'create unlogged table if not exists x_rate_limit (',
        '  key text primary key,',
        '  n int not null',
        ') with (fillfactor = 70);',
        'alter table x_rate_limit set (fillfactor = 70);',
        'alter table x_rate_limit set unlogged;',
      ].join('\n'),
    );
  });

  test('every statement survives the boot split on `;` as exactly one statement', () => {
    const statements = createTableDdl(HOT, 'key text primary key')
      .split(';')
      .filter((part) => part.trim().length > 0);
    expect(statements).toHaveLength(3);
  });

  test('a declaration stating nothing renders the plain create and no alter', () => {
    const plain = tableStorage('x_plain', {});
    expect(createTableDdl(plain, 'id int')).toBe(
      'create table if not exists x_plain (\nid int\n);',
    );
    expect(storageAlters(plain)).toEqual([]);
  });

  test('a table stated logged is set logged, so an unlogged one converges back', () => {
    expect(storageAlters(tableStorage('x_auth_lockouts', { unlogged: false }))).toEqual([
      'alter table x_auth_lockouts set logged',
    ]);
  });
});

describe('tableStorage refuses what would be spliced into DDL unchecked', () => {
  test.each([
    ['a fractional fillfactor', 'x_t', 70.5],
    ['a fillfactor under the floor', 'x_t', 9],
    ['a fillfactor over 100', 'x_t', 101],
    ['NaN', 'x_t', Number.NaN],
  ])('%s', (_label, table, fillfactor) => {
    const thrown = (() => {
      try {
        tableStorage(table, { fillfactor });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(thrown).toBeInstanceOf(DbError);
    expect((thrown as DbError).code).toBe('X_SQL_UNSAFE');
  });

  test.each(['x_t; drop table x_jobs', 'X_Upper', '"quoted"', ''])('the table name %p', (table) => {
    expect(() => tableStorage(table, { fillfactor: 70 })).toThrow(DbError);
  });

  test('the bounds themselves are accepted', () => {
    expect(tableStorage('x_t', { fillfactor: 10 }).fillfactor).toBe(10);
    expect(tableStorage('x_t', { fillfactor: 100 }).fillfactor).toBe(100);
  });
});

describe('tableStorageDrift', () => {
  test('a table holding what it declares is clean', () => {
    expect(tableStorageDrift(HOT, { unlogged: true, options: 'fillfactor=70' })).toEqual([]);
  });

  test('a fillfactor among other options is found', () => {
    const live = { unlogged: true, options: 'autovacuum_enabled=false, fillfactor=70' };
    expect(tableStorageDrift(HOT, live)).toEqual([]);
  });

  test('a logged table at the default fillfactor is two differences, each with its alter', () => {
    expect(tableStorageDrift(HOT, { unlogged: false, options: null })).toEqual([
      {
        table: 'x_rate_limit',
        parameter: 'persistence',
        declared: 'unlogged',
        live: 'logged',
        statement: 'alter table x_rate_limit set unlogged;',
        fix: `psql "$DATABASE_URL" -c 'alter table x_rate_limit set unlogged;'   # then x db migrate, which re-checks`,
      },
      {
        table: 'x_rate_limit',
        parameter: 'fillfactor',
        declared: '70',
        live: 'default (100)',
        statement: 'alter table x_rate_limit set (fillfactor = 70);',
        fix: `psql "$DATABASE_URL" -c 'alter table x_rate_limit set (fillfactor = 70);'   # then x db migrate, which re-checks`,
      },
    ]);
  });

  test('a parameter the declaration leaves out is not judged', () => {
    const onlyFill = tableStorage('x_t', { fillfactor: 90 });
    expect(tableStorageDrift(onlyFill, { unlogged: true, options: 'fillfactor=90' })).toEqual([]);
  });

  test('a missing table is one difference whose fix creates it', () => {
    expect(tableStorageDrift(HOT, undefined)).toEqual([
      {
        table: 'x_rate_limit',
        parameter: 'table',
        declared: 'present',
        live: 'absent',
        statement: null,
        fix: 'x db migrate',
      },
    ]);
  });
});
