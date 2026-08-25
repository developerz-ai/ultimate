// Which columns a script retypes, read off the SQL — the input to the view preflight, and the half
// that runs with no database. Both directions are pinned: a target MISSED is the server's own
// `0A000` one statement later (which is what happened before the preflight existed), and a target
// INVENTED is a catalog read and a refusal on a migration that would have applied.

import { describe, expect, test } from 'bun:test';
import { retypeTargets } from './dependent-view';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
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
