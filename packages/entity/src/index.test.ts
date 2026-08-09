import { describe, expect, test } from 'bun:test';
import { t as schemaT } from '@ultimat3/schema';
import { t } from './index';

describe('@ultimat3/entity public surface', () => {
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
