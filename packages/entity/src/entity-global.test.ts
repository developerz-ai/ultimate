// `entity({ global })`: the reason an entity with no tenant column belongs to every tenant. A blank
// reason, a reason on a tenant-columned entity and a reason beside `shared` are refused where they
// are written; a real one is projected, so the exercise can tell a global read from an unproven one.

import { afterAll, describe, expect, test } from 'bun:test';
import { text, uuid } from './columns';
import { entity } from './entity';
import { clearRegistry } from './registry';

afterAll(() => clearRegistry());

describe('unit · global, at declaration', () => {
  test('a blank reason is refused', () => {
    expect(() =>
      entity('eg_blank', { global: ' \n', columns: { id: uuid().primaryKey() } }),
    ).toThrow(expect.objectContaining({ code: 'X_ENTITY_TENANT_UNDECLARED' }));
  });

  test('a reason on an entity that has a tenant column is refused', () => {
    expect(() =>
      entity('eg_tenant_global', {
        global: 'reads as a decision nobody took',
        columns: { id: uuid().primaryKey(), orgId: uuid().tenant() },
      }),
    ).toThrow(expect.objectContaining({ code: 'X_INVARIANT_VIOLATED' }));
  });

  test('global beside shared is refused: one reason, one meaning', () => {
    expect(() =>
      entity('eg_both', {
        global: 'the plan catalog every org reads',
        shared: 'a link anyone may hold',
        columns: { id: uuid().primaryKey() },
      }),
    ).toThrow(expect.objectContaining({ code: 'X_INVARIANT_VIOLATED' }));
  });

  test('the reason rides the description, and is absent when undeclared', () => {
    const catalog = entity('eg_catalog', {
      global: 'the plan catalog: the same rows for every org',
      columns: { code: text().primaryKey() },
    });
    const plain = entity('eg_plain', { columns: { id: uuid().primaryKey() } });
    expect(catalog.$describe().global).toBe('the plan catalog: the same rows for every org');
    expect('global' in plain.$describe()).toBe(false);
  });
});
