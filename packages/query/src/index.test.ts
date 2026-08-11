import { describe, expect, test } from 'bun:test';
import { t as schemaT } from '@ultimat3/schema';
import * as surface from './index';
import { t } from './index';

describe('@ultimat3/query public surface', () => {
  test('a page is asked for through the query, so `paginate` is not on the barrel', () => {
    // Re-exporting it would be a second way to do what `.page()` already does, and the omission
    // is the only thing enforcing that — nothing else fails when the export comes back.
    expect(Object.keys(surface)).not.toContain('paginate');
    expect(surface).not.toHaveProperty('paginate');
  });

  test('re-exports the one `t`, not a copy of it', () => {
    // A spread or a re-implementation would still typecheck but would stop tracking
    // `configureSchemaProvider()`. Identity is the only assertion that catches that.
    expect(t).toBe(schemaT);
  });

  test('the re-exported `t` builds a working schema', () => {
    const schema = t.object({ limit: t.number.max(50) });
    expect(schema.parse({ limit: 50 })).toEqual({ limit: 50 });
    expect(() => schema.parse({ limit: 51 })).toThrow();
  });
});
