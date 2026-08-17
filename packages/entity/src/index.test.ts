import { describe, expect, test } from 'bun:test';
import { t as schemaT } from '@ultimat3/schema';
import * as entity from './index';
import { t } from './index';
import { MAX_ASSERTED_ROWS } from './invariants';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './plan';

describe('@ultimat3/entity public surface', () => {
  // README.md names these three by value. A limit an app must restate as a literal is a second
  // declaration of one number, which is what `N_PLUS_ONE_THRESHOLD` is already exported to avoid.
  test('re-exports the bounds README.md documents, and they are the same objects', () => {
    expect(entity.DEFAULT_PAGE_SIZE).toBe(DEFAULT_PAGE_SIZE);
    expect(entity.MAX_PAGE_SIZE).toBe(MAX_PAGE_SIZE);
    expect(entity.MAX_ASSERTED_ROWS).toBe(MAX_ASSERTED_ROWS);
  });

  test('the documented values are the ones the code enforces', () => {
    expect(entity.DEFAULT_PAGE_SIZE).toBe(50);
    expect(entity.MAX_PAGE_SIZE).toBe(10_000);
    expect(entity.MAX_ASSERTED_ROWS).toBe(50_000);
    expect(entity.N_PLUS_ONE_THRESHOLD).toBe(5);
  });

  test('re-exports the one `t`, not a copy of it', () => {
    // A spread or a re-implementation would still typecheck but would stop tracking
    // `configureSchemaProvider()`. Identity is the only assertion that catches that.
    expect(t).toBe(schemaT);
  });

  test('the re-exported `t` builds a working schema', () => {
    const schema = t.object({ title: t.string.max(120) });
    expect(schema.parse({ title: 'hello' })).toEqual({ title: 'hello' });
    expect(() => schema.parse({ title: 'x'.repeat(121) })).toThrow();
  });
});
