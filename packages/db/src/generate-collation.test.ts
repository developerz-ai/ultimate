// A column's declared collation (`text().collate('C')`): emitted after the type in a create or an
// add, recorded in the snapshot (absent when undeclared, so no sidecar moves), parsed back out of
// it, and a change on an existing column is an `alter column … type … collate …` with its reverse.

import { describe, expect, test } from 'bun:test';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration, snapshotOf } from './generate';
import { parseSnapshot } from './snapshot-parse';

const column = (
  name: string,
  overrides: Partial<ColumnDescriptionLike> = {},
): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind: 'text',
  notNull: true,
  primaryKey: false,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
  ...overrides,
});

const people = (name: Partial<ColumnDescriptionLike>, kind = 'text'): EntityDescriptionLike => ({
  name: 'Person',
  table: 'people',
  primaryKey: ['id'],
  columns: [column('id', { kind: 'uuid', primaryKey: true }), column('name', { kind, ...name })],
  indexes: [],
});

const C = { collation: 'C' } as const;

const diff = (now: EntityDescriptionLike, before?: EntityDescriptionLike) =>
  generateMigration({
    entities: [now],
    ...(before === undefined ? {} : { current: snapshotOf([before]) }),
    name: 'collation',
    now: new Date('2026-11-12T00:00:00.000Z'),
  });

const lines = (script: string): readonly string[] =>
  script
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('"name"'));

describe('a declared collation in DDL', () => {
  test('create table carries collate "C" right after the type', () => {
    expect(lines(diff(people(C)).up)).toEqual(['"name" text collate "C" not null,']);
  });

  test('an undeclared collation emits what it always emitted', () => {
    expect(lines(diff(people({})).up)).toEqual(['"name" text not null,']);
  });

  test('an added column carries it too', () => {
    const before: EntityDescriptionLike = { ...people({}), columns: [column('id')] };
    expect(lines(diff(people({ ...C, notNull: false }), before).up)).toEqual([
      'alter table "people" add column "name" text collate "C";',
    ]);
  });
});

describe('the snapshot', () => {
  test('records a declared collation and round-trips it through the parse', () => {
    const recorded = snapshotOf([people(C)]);
    const name = recorded.tables[0]?.columns.find((each) => each.name === 'name');
    expect(name?.collation).toBe('C');
    const parsed = parseSnapshot(JSON.parse(JSON.stringify(recorded)));
    expect(parsed?.tables[0]?.columns.find((each) => each.name === 'name')?.collation).toBe('C');
  });

  test('records nothing for an undeclared one, so no sidecar gains a key', () => {
    const name = snapshotOf([people({})]).tables[0]?.columns.find((each) => each.name === 'name');
    expect(name !== undefined && 'collation' in name).toBe(false);
  });
});

describe('a collation that moves on an existing column', () => {
  test('declaring it alters the column in place, and down restores the default', () => {
    const { up, down } = diff(people(C), people({}));
    expect(lines(up)).toEqual(['alter table "people" alter column "name" type text collate "C";']);
    expect(lines(down)).toEqual([
      'alter table "people" alter column "name" type text collate "default";',
    ]);
  });

  test('dropping it restores the default, and down declares it again', () => {
    const { up, down } = diff(people({}), people(C));
    expect(lines(up)).toEqual([
      'alter table "people" alter column "name" type text collate "default";',
    ]);
    expect(lines(down)).toEqual([
      'alter table "people" alter column "name" type text collate "C";',
    ]);
  });

  test('an unchanged collation moves nothing', () => {
    expect(lines(diff(people(C), people(C)).up)).toEqual([]);
  });

  test('a retype keeps the collation in the same statement, never a second one', () => {
    const { up, down } = diff(people(C, 'varchar(40)'), people(C));
    expect(lines(up)).toEqual([
      'alter table "people" alter column "name" type varchar(40) collate "C" using "name"::varchar(40);',
    ]);
    expect(lines(down)).toEqual([
      'alter table "people" alter column "name" type text collate "C" using "name"::text;',
    ]);
  });

  test('a retype that also declares it is one statement, with no second ALTER after it', () => {
    const { up, down } = diff(people(C, 'varchar(40)'), people({}));
    expect(lines(up)).toEqual([
      'alter table "people" alter column "name" type varchar(40) collate "C" using "name"::varchar(40);',
    ]);
    expect(lines(down)).toEqual([
      'alter table "people" alter column "name" type text using "name"::text;',
    ]);
  });
});
