// `retired` at declaration and in the description: physical names, absent when empty, and refused
// where a column would be both. The migration half is `@ultimat3/db`'s `generate-rolling.test.ts`.

import { afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { text, uuid } from './columns';
import { entity } from './entity';
import { clearRegistry } from './registry';

afterEach(() => clearRegistry());

describe('entity({ retired })', () => {
  test('the description carries the physical names', () => {
    const posts = entity('retired_posts', {
      columns: { id: uuid().primaryKey() },
      retired: ['legacy_title'],
    });
    expect(posts.$describe().retired).toEqual(['legacy_title']);
  });

  test('none is absent, so no entity hash moves', () => {
    const plain = entity('retired_plain', { columns: { id: uuid().primaryKey() } });
    const empty = entity('retired_empty', { columns: { id: uuid().primaryKey() }, retired: [] });
    expect('retired' in plain.$describe()).toBe(false);
    expect('retired' in empty.$describe()).toBe(false);
  });

  test('a retired column is out of the row and the projection', () => {
    const posts = entity('retired_row', {
      columns: { id: uuid().primaryKey(), title: text() },
      retired: ['legacy'],
    });
    expect(posts.$describe().columns.map((column) => column.column)).toEqual(['id', 'title']);
  });

  test('a name still declared, by its physical spelling, is refused at declaration', () => {
    let thrown: unknown;
    try {
      entity('retired_both', {
        columns: { id: uuid().primaryKey(), legacyTitle: text() },
        retired: ['legacy_title'],
      });
    } catch (error) {
      thrown = error;
    }
    expect(isUltimateError(thrown) ? thrown.code : '').toBe('X_INVARIANT_VIOLATED');
  });
});
