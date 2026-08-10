import { describe, expect, test } from 'bun:test';
import { t as schemaT } from '@ultimat3/schema';
import { t } from './index';

describe('@ultimat3/ai public surface', () => {
  test('re-exports the one `t`, not a copy of it', () => {
    // A spread or a re-implementation would still typecheck but would stop tracking
    // `configureSchemaProvider()`. Identity is the only assertion that catches that.
    expect(t).toBe(schemaT);
  });

  test('the re-exported `t` builds a working `llm` output schema', () => {
    // `llm()` projects its `output` into the tool the model must answer through, so the
    // schema an author writes here is the one that rejects a malformed completion.
    const schema = t.object({ summary: t.string, tags: t.array(t.string) });

    expect(schema.parse({ summary: 'ok', tags: ['a'] })).toEqual({ summary: 'ok', tags: ['a'] });
    expect(() => schema.parse({ summary: 'ok', tags: 'a' })).toThrow();
  });
});
