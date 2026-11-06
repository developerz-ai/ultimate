// `entity({ scan })`: why a table may be read by a sequential scan — a bounded catalog. A blank
// reason is refused where it is written; a real one rides the description for the plan sweep.

import { afterAll, describe, expect, test } from 'bun:test';
import { uuid } from './columns';
import { entity } from './entity';
import { clearRegistry } from './registry';

afterAll(() => clearRegistry());

describe('unit · scan, at declaration', () => {
  test('a blank reason is refused', () => {
    expect(() => entity('esc_blank', { scan: ' ', columns: { id: uuid().primaryKey() } })).toThrow(
      expect.objectContaining({ code: 'X_INVARIANT_VIOLATED' }),
    );
  });

  test('an empty reason is refused', () => {
    expect(() => entity('esc_empty', { scan: '', columns: { id: uuid().primaryKey() } })).toThrow(
      expect.objectContaining({ code: 'X_INVARIANT_VIOLATED' }),
    );
  });

  test('the reason rides the description, and is absent when undeclared', () => {
    const plans = entity('esc_plans', {
      scan: 'a closed catalog of 8 rows',
      columns: { id: uuid().primaryKey() },
    });
    const plain = entity('esc_plain', { columns: { id: uuid().primaryKey() } });
    expect(plans.$describe().scan).toBe('a closed catalog of 8 rows');
    expect('scan' in plain.$describe()).toBe(false);
  });
});
