// The storage declaration as text: what `tableDdl` renders for the boot's `;` split, which
// declarations are refused before they reach DDL, and what drift says against a catalog row.

import { describe, expect, test } from 'bun:test';
import { DbError } from './errors';
import { storageAlters, tableDdl, tableStorage } from './table-storage';
import { tableStorageDrift } from './table-storage-drift';

const HOT = tableStorage('x_rate_limit', { fillfactor: 70, unlogged: true });

describe('tableDdl', () => {
  test('an unlogged fillfactor table is created that way and re-applied to an existing one', () => {
    const ddl = tableDdl(HOT, '\n  key text primary key,\n  n int not null\n');
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
    const statements = tableDdl(HOT, 'key text primary key')
      .split(';')
      .filter((part) => part.trim().length > 0);
    expect(statements).toHaveLength(3);
  });

  test('a declaration stating nothing renders the plain create and no alter', () => {
    const plain = tableStorage('x_plain', {});
    expect(tableDdl(plain, 'id int')).toBe('create table if not exists x_plain (\nid int\n);');
    expect(storageAlters(plain)).toEqual([]);
  });

  test('a table stated logged is set logged, so an unlogged one converges back', () => {
    expect(storageAlters(tableStorage('x_auth_lockouts', { unlogged: false }))).toEqual([
      'alter table x_auth_lockouts set logged',
    ]);
  });
});

describe('tableDdl trims its column body in one linear pass', () => {
  // `/\s+$/g` retried at every space of a run that ends before a non-space: n²/2 steps for one
  // run of n. CodeQL js/polynomial-redos. 50,000 spaces is 1.25 billion steps that way, and
  // 100,000 characters here: the input size is the bound, so a quadratic trim times the test out.
  const RUN = ' '.repeat(50_000);

  test('a long inner run of spaces is kept whole, and only the edges are trimmed', () => {
    const body = `\n\nkey text${RUN}primary key${RUN}`;
    const ddl = tableDdl(tableStorage('x_t', {}), body);
    expect(ddl).toBe(`create table if not exists x_t (\nkey text${RUN}primary key\n);`);
  });

  test('a body of nothing but whitespace trims to empty', () => {
    expect(tableDdl(tableStorage('x_t', {}), `\n${RUN}\t\n`)).toBe(
      'create table if not exists x_t (\n\n);',
    );
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

  test('a fillfactor written with a leading zero is the number it states', () => {
    expect(tableStorageDrift(HOT, { unlogged: true, options: 'fillfactor=070' })).toEqual([]);
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

describe('autovacuum', () => {
  const OUTBOX = tableStorage('x_outbox', {
    autovacuum: {
      vacuumThreshold: 100,
      vacuumScaleFactor: 0.02,
      analyzeThreshold: 100,
      analyzeScaleFactor: 0.02,
    },
  });
  const SET =
    'alter table x_outbox set (autovacuum_vacuum_threshold = 100, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_threshold = 100, autovacuum_analyze_scale_factor = 0.02)';
  const LIVE =
    'autovacuum_vacuum_threshold=100, autovacuum_vacuum_scale_factor=0.02, autovacuum_analyze_threshold=100, autovacuum_analyze_scale_factor=0.02';

  test('is created with the table and re-applied by one alter', () => {
    expect(tableDdl(OUTBOX, 'id uuid primary key')).toBe(
      [
        'create table if not exists x_outbox (',
        'id uuid primary key',
        ') with (autovacuum_vacuum_threshold = 100, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_threshold = 100, autovacuum_analyze_scale_factor = 0.02);',
        `${SET};`,
      ].join('\n'),
    );
  });

  test('beside a fillfactor, both reach the create and each keeps its own alter', () => {
    const both = tableStorage('x_t', { fillfactor: 80, autovacuum: { vacuumThreshold: 20 } });
    expect(tableDdl(both, 'id int')).toBe(
      [
        'create table if not exists x_t (',
        'id int',
        ') with (fillfactor = 80, autovacuum_vacuum_threshold = 20);',
        'alter table x_t set (fillfactor = 80);',
        'alter table x_t set (autovacuum_vacuum_threshold = 20);',
      ].join('\n'),
    );
  });

  test('a table holding the declaration is clean, whatever else its options carry', () => {
    expect(
      tableStorageDrift(OUTBOX, { unlogged: false, options: `fillfactor=90, ${LIVE}` }),
    ).toEqual([]);
  });

  test('a hand reset is one difference per parameter, each converged by the alter', () => {
    const live = {
      unlogged: false,
      options: 'autovacuum_vacuum_threshold=100, autovacuum_analyze_threshold=100',
    };
    expect(tableStorageDrift(OUTBOX, live)).toEqual(
      ['autovacuum_vacuum_scale_factor', 'autovacuum_analyze_scale_factor'].map((parameter) => ({
        table: 'x_outbox',
        parameter,
        declared: '0.02',
        live: 'default',
        statement: `${SET};`,
        fix: `psql "$DATABASE_URL" -c '${SET};'   # then x db migrate, which re-checks`,
      })),
    );
  });

  test('a changed value is reported with what the table holds', () => {
    const live = { unlogged: false, options: LIVE.replace('threshold=100,', 'threshold=50,') };
    expect(tableStorageDrift(OUTBOX, live)).toMatchObject([
      { parameter: 'autovacuum_vacuum_threshold', declared: '100', live: '50' },
    ]);
  });

  test.each([
    ['a fractional threshold', { vacuumThreshold: 1.5 }],
    ['a negative threshold', { analyzeThreshold: -1 }],
    ['a threshold past int4', { vacuumThreshold: 2 ** 31 }],
    ['a negative scale factor', { vacuumScaleFactor: -0.1 }],
    ['a scale factor over 100', { analyzeScaleFactor: 101 }],
    ['an infinite scale factor', { vacuumScaleFactor: Number.POSITIVE_INFINITY }],
    ['a key inherited from Object.prototype', { constructor: 1 }],
    ['another inherited key', { toString: 5 }],
  ])('refuses %s', (_label, autovacuum) => {
    expect(() => tableStorage('x_t', { autovacuum })).toThrow(DbError);
  });

  test('the bounds themselves are accepted', () => {
    const edge = tableStorage('x_t', {
      autovacuum: { vacuumThreshold: 0, vacuumScaleFactor: 100, analyzeScaleFactor: 0 },
    });
    expect(edge.autovacuum).toEqual({
      vacuumThreshold: 0,
      vacuumScaleFactor: 100,
      analyzeScaleFactor: 0,
    });
  });
});
