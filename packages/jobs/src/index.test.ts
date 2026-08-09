import { describe, expect, test } from 'bun:test';
import { t as schemaT } from '@ultimat3/schema';
import { t } from './index';

describe('@ultimat3/jobs public surface', () => {
  test('re-exports the one `t`, not a copy of it', () => {
    // A spread or a re-implementation would still typecheck but would stop tracking
    // `configureSchemaProvider()`. Identity is the only assertion that catches that.
    expect(t).toBe(schemaT);
  });

  test('the re-exported `t` builds a working schema', () => {
    const schema = t.object({ orgId: t.uuid });
    expect(schema.parse({ orgId: '00000000-0000-4000-8000-000000000000' })).toEqual({
      orgId: '00000000-0000-4000-8000-000000000000',
    });
    expect(() => schema.parse({ orgId: 42 })).toThrow();
  });
});
