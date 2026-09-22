import { afterAll, describe, expect, test } from 'bun:test';
import { uuid } from './columns';
import { entity } from './entity';
import { persistedRecordTypes } from './persisted-types';
import { clearRegistry } from './registry';

afterAll(() => {
  clearRegistry();
});

describe('persistedRecordTypes()', () => {
  test('names every persist: true entity, sorted, and no other', () => {
    entity('persisted_types_zeta', { persist: true, columns: { id: uuid().primaryKey() } });
    entity('persisted_types_plain', { columns: { id: uuid().primaryKey() } });
    entity('persisted_types_alpha', { persist: true, columns: { id: uuid().primaryKey() } });
    const types = persistedRecordTypes().filter((name) => name.startsWith('persisted_types_'));
    expect(types).toEqual(['persisted_types_alpha', 'persisted_types_zeta']);
  });

  test('a later registration is seen — the cache follows the registry generation', () => {
    const before = persistedRecordTypes();
    entity('persisted_types_late', { persist: true, columns: { id: uuid().primaryKey() } });
    expect(before).not.toContain('persisted_types_late');
    expect(persistedRecordTypes()).toContain('persisted_types_late');
  });
});
