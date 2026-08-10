import { describe, expect, test } from 'bun:test';
import { t as schemaT } from '@ultimat3/schema';
import { defineAppMcp, t } from './index';

describe('@ultimat3/mcp public surface', () => {
  test('re-exports the one `t`, not a copy of it', () => {
    // A spread or a re-implementation would still typecheck but would stop tracking
    // `configureSchemaProvider()`. Identity is the only assertion that catches that.
    expect(t).toBe(schemaT);
  });

  test('the re-exported `t` builds a working hand-written tool input', () => {
    const mcp = defineAppMcp({
      name: 'index-test',
      tools: {
        seatReport: {
          description: 'Seats used, remaining and the plan limit. Read-only.',
          input: t.object({ orgId: t.string }),
          policy: 'org:administer',
          destructive: false,
          handle: () => ({ used: 3 }),
        },
      },
    });

    // The published JSON Schema is derived from the author's `t` — a copied `t` would still
    // produce one, so the assertion is that this one describes the declared field.
    const tool = mcp.tools.find((candidate) => candidate.name === 'seatReport');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', required: ['orgId'] });
  });
});
