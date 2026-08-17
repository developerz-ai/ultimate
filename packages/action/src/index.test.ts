import { describe, expect, test } from 'bun:test';
import { can } from '@ultimat3/policy';
import { t as schemaT } from '@ultimat3/schema';
import * as surface from './index';
import { t } from './index';

/**
 * What `invoke.ts` keeps private. Re-exporting any of them hands `handle` a second caller,
 * and a second caller is a second parse, a second authz evaluation and a second output check.
 * `CLAUDE.md` calls this absence the enforcement — this test is what makes that true.
 */
const PRIVATE_TO_INVOKE = ['defOf', 'stashDef', 'hasDef'] as const;

/**
 * The tool-name derivers this package must never grow back. `toToolName` snake_cased an MCP tool
 * name until 2026-08 while `@ultimat3/mcp` served the export name verbatim, so `openapi.json` and
 * every descriptor reader published a name `tools/call` answers not-found for. The only test that
 * caught it lived in `@ultimat3/mcp` — tier 4, which this package cannot import, so the rule was
 * enforced one tier above where it can be broken.
 */
const NO_TOOL_NAME_DERIVER = ['toToolName', 'deriveToolName', 'toolNameFor'] as const;

const publishPost = surface
  .action({
    input: schemaT.object({ postId: schemaT.uuid }),
    output: schemaT.object({ id: schemaT.uuid }),
    policy: can('post:publish'),
    handle: ({ input }) => ({ id: input.postId }),
  })
  .named('publishPost');

describe('@ultimat3/action public surface', () => {
  test('re-exports the one `t`, not a copy of it', () => {
    // A spread or a re-implementation would still typecheck but would stop tracking
    // `configureSchemaProvider()`. Identity is the only assertion that catches that.
    expect(t).toBe(schemaT);
  });

  test('the re-exported `t` builds a working schema', () => {
    const schema = t.object({ postId: t.uuid });
    expect(schema.parse({ postId: '00000000-0000-4000-8000-000000000000' })).toEqual({
      postId: '00000000-0000-4000-8000-000000000000',
    });
    expect(() => schema.parse({ postId: 'nope' })).toThrow();
  });

  test('never exports a reader of the declaration store', () => {
    const exported = Object.keys(surface);

    for (const name of PRIVATE_TO_INVOKE) expect(exported).not.toContain(name);
    // The positive half: the one execution path IS exported, because every surface needs it.
    expect(exported).toContain('invoke');
  });

  // Two halves of one rule, pinned HERE because tier 3 cannot import the tier-4 test that
  // caught the original bug: an MCP tool's name is the export name, and nothing derives one.
  test('the tool name is the registered name, and no deriver is exported', () => {
    // Structural, with no literal to drift: whatever the action was registered as IS the tool.
    expect(surface.describeAction(publishPost).mcp.tool).toBe(publishPost.name);
    expect(publishPost.tool().name).toBe(publishPost.name);

    const exported = Object.keys(surface);
    for (const name of NO_TOOL_NAME_DERIVER) expect(exported).not.toContain(name);
    // The positive half: PATH derivation is still this package's job and stays exported.
    expect(exported).toContain('derivePath');
  });

  test('no projection carries the declaration out with it', () => {
    const projections: readonly [string, object][] = [
      ['describe', publishPost.describe()],
      ['tool', publishPost.tool()],
      ['openapi', publishPost.openapi()],
      ['job', publishPost.job()],
      ['route', surface.toRoute(publishPost)],
    ];

    for (const [, projection] of projections) {
      // `route` legitimately carries a `handler` — a closure over `invoke`. A `handle` or a
      // `def` would be the declaration itself, reachable from whoever holds the projection.
      // Asked by property access, not `Object.keys`: a non-enumerable or inherited `def` is
      // still reachable by whoever holds the projection, and a key list would not see it.
      expect(projection).not.toHaveProperty('handle');
      expect(projection).not.toHaveProperty('def');
    }
  });
});
