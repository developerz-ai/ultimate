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

  test('no tool-name deriver on the barrel — a read has ONE name, its export name', () => {
    // `@ultimat3/mcp` serves a read under `queryName(target)` and answers `tools/call` for
    // nothing else, so any second spelling names a tool the server has never heard of. That
    // package is tier 4 and cannot be imported here to prove it, which is exactly why the pin
    // has to live in the package where the deriver can be reintroduced.
    // `mcp-tool.test.ts` pins the descriptor's name structurally; this pins the ABSENCE.
    expect(surface).not.toHaveProperty('toToolName');
    const derivers = Object.keys(surface).filter((key) => /tool_?name/i.test(key));
    expect(derivers).toEqual([]);
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
