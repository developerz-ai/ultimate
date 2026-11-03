// The rolling-deploy rail over committed SQL: a closed list, on real statements only, the way
// `destructive.ts` reads. The markers declare a retire and its contract; prose never does.

import { describe, expect, test } from 'bun:test';
import {
  columnKey,
  contractsMarker,
  hasRollingUnsafeMarker,
  ROLLING_UNSAFE_MARKER,
  retireAndContractPending,
  retiredColumnsIn,
  retiresMarker,
  rollingUnsafeStatements,
} from './rolling';

describe('rollingUnsafeStatements', () => {
  test('a drop with no earlier retire is reported, with its names', () => {
    expect(rollingUnsafeStatements('alter table "t" drop column "c";')).toEqual([
      {
        kind: 'drop-column',
        table: 't',
        column: 'c',
        statement: 'alter table "t" drop column "c"',
      },
    ]);
  });

  test('every spelling of a drop is one drop', () => {
    for (const up of [
      'ALTER TABLE t DROP c;',
      'alter table only public.t drop column if exists C;',
      'alter table if exists "t" drop "c" cascade;',
    ]) {
      expect(rollingUnsafeStatements(up).map(({ table, column }) => [table, column])).toEqual([
        ['t', 'c'],
      ]);
    }
  });

  test('every subcommand of one alter is judged', () => {
    const found = rollingUnsafeStatements(
      'alter table t add column x text, drop a, drop column b;',
    );
    expect(found.map(({ column }) => column)).toEqual(['a', 'b']);
  });

  test('a drop an earlier migration retired is safe, and only that name', () => {
    const retired = new Set(retiredColumnsIn(retiresMarker('t', 'c')));
    expect(rollingUnsafeStatements('alter table t drop column c;', retired)).toEqual([]);
    expect(rollingUnsafeStatements('alter table t drop column d;', retired).length).toBe(1);
    expect(rollingUnsafeStatements('alter table u drop column c;', retired).length).toBe(1);
  });

  test('renames are the other two kinds', () => {
    expect(rollingUnsafeStatements('alter table t rename column a to b;')[0]).toMatchObject({
      kind: 'rename-column',
      column: 'a',
    });
    expect(rollingUnsafeStatements('alter table t rename a to b;')[0]?.kind).toBe('rename-column');
    expect(rollingUnsafeStatements('alter table t rename to u;')[0]?.kind).toBe('rename-table');
  });

  test('what rebuilds or is prose is not on the list', () => {
    for (const up of [
      'alter table t drop constraint k;',
      'alter table t drop constraint if exists k, add constraint k check (a > 0) not valid;',
      'alter table t alter column a drop default;',
      'alter table t alter column a drop not null;',
      'alter table t rename constraint a to b;',
      '-- alter table t drop column c;',
      "insert into audit values ('alter table t drop column c;');",
      'select 1; /* alter table t rename to u; */',
      'create function f() returns void as $$ alter table t drop column c; $$ language sql;',
      'alter table "drop column x" add column y text;',
    ]) {
      expect(rollingUnsafeStatements(up)).toEqual([]);
    }
  });
});

describe('markers', () => {
  test('a retire is a top-level line of its own, never a mention', () => {
    expect(retiredColumnsIn(`${retiresMarker('t', 'c')}\nselect 1;`)).toEqual([
      columnKey('t', 'c'),
    ]);
    expect(retiredColumnsIn('/* -- retires "t"."c" */ select 1;')).toEqual([]);
    expect(retiredColumnsIn('select \'-- retires "t"."c"\';')).toEqual([]);
    expect(retiredColumnsIn('-- retires "t"."c" was the plan')).toEqual([]);
  });

  test('the rolling-unsafe marker is the whole comment', () => {
    expect(hasRollingUnsafeMarker(`${ROLLING_UNSAFE_MARKER}\nselect 1;`)).toBe(true);
    expect(hasRollingUnsafeMarker('-- rolling-unsafe: true is what you add')).toBe(false);
    expect(hasRollingUnsafeMarker('/* -- rolling-unsafe: true */')).toBe(false);
  });
});

describe('retireAndContractPending', () => {
  const retire = { id: '1_retire', name: 'retire', up: retiresMarker('t', 'c'), down: '' };
  const contract = {
    id: '2_drop',
    name: 'drop',
    up: `${contractsMarker('t', 'c')}\nalter table "t" drop column "c";`,
    down: '',
  };

  test('both pending is the pair', () => {
    expect(retireAndContractPending([retire, contract])).toMatchObject({
      table: 't',
      column: 'c',
      retire: '1_retire',
      contract: '2_drop',
    });
  });

  test('a name holding a dot comes back whole, and no two columns share a key', () => {
    const dotted = { ...retire, up: retiresMarker('a.b', 'c') };
    const drop = { ...contract, up: contractsMarker('a.b', 'c') };
    expect(retireAndContractPending([dotted, drop])).toMatchObject({ table: 'a.b', column: 'c' });
    const other = { ...retire, up: retiresMarker('a', 'b.c') };
    expect(retireAndContractPending([other, drop])).toBeUndefined();
  });

  test('either alone is a deploy that already split them', () => {
    expect(retireAndContractPending([retire])).toBeUndefined();
    expect(retireAndContractPending([contract])).toBeUndefined();
  });

  test('another column retired is not this contract', () => {
    const other = { ...retire, up: retiresMarker('t', 'd') };
    expect(retireAndContractPending([other, contract])).toBeUndefined();
  });
});
