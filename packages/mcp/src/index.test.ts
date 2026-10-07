import { describe, expect, test } from 'bun:test';
import { t as schemaT } from '@ultimat3/schema';
import * as surface from './index';
import { defineAppMcp, t } from './index';

describe('@ultimat3/mcp public surface', () => {
  // 25.0.0 (plan 101, M3): one name per thing. `toolFromQuery` was `toolFrom` under a second
  // name, and `isExposed` was core's `isMcpExposed` behind a wrapper — two spellings each.
  // `toolFromAction` is the projection's pre-25 name: it takes queries too and pairs with
  // `toolsFrom`, so it is `toolFrom`, and the old spelling is not kept as an alias.
  test('no alias of the one projection, and no wrapper over core’s exposure predicate', () => {
    for (const name of ['toolFromQuery', 'toolFromAction', 'isExposed']) {
      expect(surface).not.toHaveProperty(name);
    }
    expect(typeof surface.toolFrom).toBe('function');
  });

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
