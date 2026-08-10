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
