/**
 * The barrel must re-export the ONE `t` from `@ultimat3/schema` by identity, never a copy — `t`
 * delegates to `schemaProvider()` on every access, so a spread or a re-declaration would freeze
 * the provider at import time and still typecheck, still build an `llm` output schema. Identity
 * is the only assertion that catches that, which is why this file exists.
 */

import { describe, expect, test } from 'bun:test';
import { t as schemaT } from '@ultimat3/schema';
import * as surface from './index';
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

  // 25.0.0: a prompt's identity is `promptHash`. It was `contentHash`, the name render's
  // byte hash (xxHash32, `@ultimat3/render/server`) also answers to — one name, two functions.
  test('the prompt hash is `promptHash`, and `contentHash` is no alias of it', () => {
    expect(surface).not.toHaveProperty('contentHash');
    expect(typeof surface.promptHash).toBe('function');
  });
});
