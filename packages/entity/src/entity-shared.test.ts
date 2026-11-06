// `entity({ shared })`: the reason an entity with no tenant belongs to none. A blank reason and a
// reason on a tenant-columned entity are refused where they are written; a real one is projected.

import { afterAll, describe, expect, test } from 'bun:test';
import { uuid } from './columns';
import { entity } from './entity';
import { clearRegistry } from './registry';

afterAll(() => clearRegistry());

describe('unit · shared, at declaration', () => {
  test('a blank reason is refused', () => {
    expect(() =>
      entity('es_blank', { shared: '  ', columns: { id: uuid().primaryKey() } }),
    ).toThrow(expect.objectContaining({ code: 'X_ENTITY_TENANT_UNDECLARED' }));
  });

  test('a reason on an entity that has a tenant column is refused', () => {
    expect(() =>
      entity('es_tenant_shared', {
        shared: 'reads as a decision nobody took',
        columns: { id: uuid().primaryKey(), orgId: uuid().tenant() },
      }),
    ).toThrow(expect.objectContaining({ code: 'X_INVARIANT_VIOLATED' }));
  });

  test('the reason rides the description, and is absent when undeclared', () => {
    const links = entity('es_links', {
      shared: 'a public share link, readable by anyone holding it',
      columns: { id: uuid().primaryKey() },
    });
    const plain = entity('es_plain', { columns: { id: uuid().primaryKey() } });
    expect(links.$describe().shared).toBe('a public share link, readable by anyone holding it');
    expect('shared' in plain.$describe()).toBe(false);
  });
});
