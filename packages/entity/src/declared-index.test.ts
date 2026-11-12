// E8: an `indexes:` entry may say what `@ultimat3/db` already renders — an expression key, a
// direction per key, INCLUDE payload, the trigram operator class — and reaches the migration
// whole. Every part is absent by default, so no existing name, description or hash moves.

import { describe, expect, test } from 'bun:test';
import { generateMigration, snapshotOf } from '@ultimat3/db';
import { text, uuid } from './columns';
import { entity } from './entity';
import { distinctIndexes } from './index-identity';
import type { IndexInit } from './index-init';
import { uniqueConstraints } from './unique-constraints';

// A column binds to one entity, so every declaration gets its own.
const columns = () => ({
  id: uuid().primaryKey(),
  email: text({ max: 200 }),
  name: text({ max: 200 }),
  title: text({ max: 200 }).column('headline'),
});
type Columns = ReturnType<typeof columns>;

let serial = 0;
const declare = (indexes: readonly IndexInit<Columns>[]) => {
  serial += 1;
  return entity(`e8_people_${serial}`, { columns: columns(), indexes });
};

const migrationOf = (indexes: readonly IndexInit<Columns>[]): string => {
  const people = declare(indexes);
  return generateMigration({
    entities: [people.$describe()],
    current: snapshotOf([]),
    name: 'e8',
    now: new Date('2026-11-11T00:00:00.000Z'),
  }).up;
};

const refusal = (indexes: readonly IndexInit<Columns>[]): string => {
  try {
    declare(indexes);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return expect.unreachable('the declaration was accepted');
};

describe('unit · the four key parts reach the migration', () => {
  test('a unique expression key: unique(lower(email))', () => {
    const up = migrationOf([{ on: ['email'], expression: 'lower(email)', unique: true }]);
    expect(up).toMatch(
      /create unique index "e8_people_\d+_email_[0-9a-f]{8}_key" on "e8_people_\d+" \(\(lower\(email\)\)\);/,
    );
  });

  test('a direction per key', () => {
    const up = migrationOf([{ on: ['email', 'name'], orders: [null, 'desc'] }]);
    expect(up).toContain('("email", "name" desc);');
  });

  test('INCLUDE payload, by its physical name', () => {
    const up = migrationOf([{ on: ['email'], include: ['title'] }]);
    expect(up).toContain('("email") include ("headline");');
  });

  test('the trigram operator class on a gin index, with its extension', () => {
    const up = migrationOf([{ on: ['name'], using: 'gin', operatorClass: 'gin_trgm_ops' }]);
    expect(up).toContain('using gin ("name" gin_trgm_ops);');
    expect(up).toContain('pg_trgm');
  });
});

describe('unit · absent by default', () => {
  test('a plain index carries none of the four and keeps the name it always had', () => {
    const people = declare([{ on: ['email'] }]);
    const index = people.$describe().indexes.find((each) => each.columns[0] === 'email');
    expect(index?.name).toBe(`${people.$table}_email_idx`);
    for (const part of ['expression', 'orders', 'include', 'operatorClass']) {
      expect(index !== undefined && part in index).toBe(false);
    }
  });

  test('two expression indexes on one column are two names and two indexes', () => {
    const people = declare([
      { on: ['email'], expression: 'lower(email)' },
      { on: ['email'], expression: 'upper(email)' },
    ]);
    const [lower, upper] = people.$indexes;
    expect(lower?.name).not.toBe(upper?.name);
    expect(distinctIndexes(people.$indexes)).toHaveLength(2);
  });

  test('a unique expression is no conflict target: `on conflict (email)` cannot infer it', () => {
    const people = declare([{ on: ['email'], expression: 'lower(email)', unique: true }]);
    expect(uniqueConstraints(people)).toEqual([]);
  });
});

describe('unit · refused where it was written', () => {
  test.each([
    ['an operator class on a btree', [{ on: ['name'], operatorClass: 'gin_trgm_ops' }], 'gin'],
    ['orders not one per key', [{ on: ['email', 'name'], orders: ['desc'] }], 'one per key'],
    ['order beside orders', [{ on: ['email'], order: 'asc', orders: ['desc'] }], 'orders'],
    ['orders on a gin', [{ on: ['name'], using: 'gin', orders: ['desc'] }], 'btree'],
    ['include on a gin', [{ on: ['name'], using: 'gin', include: ['email'] }], 'btree'],
    ['a blank expression', [{ on: ['email'], expression: '  ' }], 'expression'],
    ['an empty include', [{ on: ['email'], include: [] }], 'include'],
  ] as const)('%s', (_, indexes, says) => {
    expect(refusal(indexes as readonly IndexInit<Columns>[])).toContain(says);
  });
});
