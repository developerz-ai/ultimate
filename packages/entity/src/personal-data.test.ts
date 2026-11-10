import { afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { integer, money, text, uuid } from './columns';
import { entity } from './entity';
import { personalDataEntities, personalDataKindOf, personalDataOf } from './personal-data';
import { PERSONAL_DATA_KINDS, type PersonalDataKind } from './personal-data-kind';
import { clearRegistry } from './registry';

afterEach(() => clearRegistry());

const declareUsers = () =>
  entity('pd_users', {
    columns: {
      id: uuid().primaryKey(),
      orgId: uuid().tenant(),
      email: text().unique().personalData('contact'),
      // Chained AFTER the marker too: the mark must survive every link, or the order of a chain
      // decides whether a column is erased.
      nickname: text().personalData('identifier').nullable(),
      bio: text({ max: 400 }).personalData('free-text').nullable().column('about'),
      balance: money(),
      age: integer(),
    },
  });

describe('.personalData()', () => {
  test('marks a column with its kind and changes nothing else about it', () => {
    const plain = text().unique();
    const marked = text().unique().personalData('contact');
    expect(personalDataKindOf(marked)).toBe('contact');
    expect(personalDataKindOf(plain)).toBeUndefined();
    expect(marked.$meta).toEqual({ ...plain.$meta, personalData: 'contact' });
    expect(marked.$parse('a@b.c')).toBe('a@b.c');
  });

  test('every chain link after the marker keeps it', () => {
    const users = declareUsers();
    expect(personalDataKindOf(users.nickname)).toBe('identifier');
    expect(users.nickname.$meta.notNull).toBe(false);
    expect(personalDataKindOf(users.bio)).toBe('free-text');
    expect(users.bio.$meta.name).toBe('about');
  });

  test('an unknown kind is refused where it was written', () => {
    let code = 'answered';
    try {
      text().personalData('secret' as PersonalDataKind);
    } catch (error) {
      code = isUltimateError(error) ? error.code : 'not coded';
    }
    expect(code).toBe('X_INVARIANT_VIOLATED');
    expect(PERSONAL_DATA_KINDS).toEqual(['identifier', 'contact', 'free-text']);
  });
});

describe('personalDataOf()', () => {
  test('lists every marked column of an entity, in declaration order, physical name resolved', () => {
    const users = declareUsers();
    expect(personalDataOf(users)).toEqual([
      { property: 'email', column: 'email', kind: 'contact', columnKind: 'text', nullable: false },
      {
        property: 'nickname',
        column: 'nickname',
        kind: 'identifier',
        columnKind: 'text',
        nullable: true,
      },
      { property: 'bio', column: 'about', kind: 'free-text', columnKind: 'text', nullable: true },
    ]);
  });

  test('an entity with no marked column answers none', () => {
    const plain = entity('pd_plain', { columns: { id: uuid().primaryKey(), title: text() } });
    expect(personalDataOf(plain)).toEqual([]);
  });
});

describe('personalDataEntities()', () => {
  test('walks the registry: only entities holding a marked column, with their tenant', () => {
    declareUsers();
    entity('pd_plain', { columns: { id: uuid().primaryKey(), title: text() } });
    const found = personalDataEntities();
    expect(found.map((each) => [each.entity.$name, each.tenantColumn])).toEqual([
      ['pd_users', 'orgId'],
    ]);
    expect(found[0]?.columns.map((column) => column.property)).toEqual([
      'email',
      'nickname',
      'bio',
    ]);
  });
});
