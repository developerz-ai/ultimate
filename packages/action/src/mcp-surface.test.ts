// What this package still says about an action's MCP tool, now that it builds none (O-tool,
// 25.0.0): whether one exists, under which name, and that a call on the `mcp` surface reaches the
// same policy as the HTTP route. The tool itself is `@ultimat3/mcp`'s one projection, which calls
// `invoke(target, input, { surface: 'mcp' })` — so that call is what is asserted here.

import { describe, expect, test } from 'bun:test';
import { ctxOf, isMcpExposed, runWithContext, userActor } from '@ultimat3/core';
import { defineHttpConfig, requestContext, UltimateRequest } from '@ultimat3/http';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action, describeAction } from './action';
import { toOpenApiOperation, toRoute } from './http';
import { invoke } from './invoke';

const Input = t.object({ postId: t.uuid });
const Output = t.object({ id: t.uuid, published: t.boolean });
const POST_ID = '00000000-0000-4000-8000-0000000000aa';

/** No actor: core's anonymous actor is what an unauthenticated request carries. */
const anonymous = ctxOf({});
const editorActor = { ...userActor({ id: 'u1' }), permissions: ['post:publish'] };
const editor = ctxOf({ actor: editorActor });

function defineCounted() {
  const seen: unknown[] = [];
  const target = action({
    input: Input,
    output: Output,
    policy: can<{ postId: string }>('post:publish', ({ actor }) => {
      seen.push(actor);
      return actor !== null;
    }),
    handle: () => ({ id: POST_ID, published: true }),
  }).named('publishPost');
  return { target, seen };
}

function requestFor(path: string, body: unknown) {
  const url = new URL(`https://app.test${path}`);
  const config = defineHttpConfig({ dev: true, rateLimit: { scope: 'process' } });
  const rctx = requestContext({ url, method: 'POST', role: 'web', config });
  const raw = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { request: new UltimateRequest(raw, rctx), rctx };
}

const viaMcp = (target: ReturnType<typeof defineCounted>['target'], input: unknown) =>
  invoke(target, input, { surface: 'mcp' });

describe('one authz system', () => {
  test('the HTTP route and the MCP surface run the same policy evaluation', async () => {
    const { target, seen } = defineCounted();
    const route = toRoute(target);
    const { request, rctx } = requestFor('/api/posts/publish', { postId: POST_ID });

    const refusal = await runWithContext(anonymous, () =>
      Promise.resolve(route.handler(request, rctx)).catch((error: unknown) => error),
    );
    const denial = await runWithContext(anonymous, () =>
      viaMcp(target, { postId: POST_ID }).catch((error: unknown) => error),
    );

    // No actor at all, so the permission clause short-circuits before the predicate.
    expect(seen).toEqual([]);
    expect((refusal as { code?: string }).code).toBe('X_UNAUTHENTICATED');
    expect((denial as { code?: string }).code).toBe('X_UNAUTHENTICATED');
  });

  test('an authorized actor runs the same predicate once per surface', async () => {
    const { target, seen } = defineCounted();
    const route = toRoute(target);
    const { request, rctx } = requestFor('/api/posts/publish', { postId: POST_ID });

    const response = await runWithContext(editor, () => route.handler(request, rctx));
    const answered = await runWithContext(editor, () => viaMcp(target, { postId: POST_ID }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: POST_ID, published: true });
    expect(answered).toEqual({ id: POST_ID, published: true });
    expect(seen).toEqual([editorActor, editorActor]);
  });
});

describe('exposure is opt-in, and every reader agrees', () => {
  const declaring = (mcp?: { expose: boolean }) =>
    action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      ...(mcp === undefined ? {} : { mcp }),
      handle: () => ({ id: POST_ID, published: true }),
    }).named('publishPost');

  // Both are CONTRACT surfaces — the manifest fact `x verify` diffs and the OpenAPI operation an
  // agent reads — so publishing a tool the catalog refuses to serve is worse than publishing none.
  test('the manifest fact and the OpenAPI hint both answer core’s one predicate', () => {
    for (const mcp of [undefined, { expose: false }, { expose: true }] as const) {
      const target = declaring(mcp);
      const exposed = isMcpExposed(target.mcp);
      expect(exposed).toBe(mcp?.expose === true);
      expect(describeAction(target).mcp.expose).toBe(exposed);
      expect(toOpenApiOperation(target)['x-ultimate']['mcpTool'] !== null).toBe(exposed);
    }
  });
});

// `@ultimat3/mcp` serves the export name verbatim — what a `tools/call` spells and what
// `defineAppMcp`'s `scopes:` is keyed on. Both names this package publishes must be that string.
describe('one name per action, on every surface this package publishes', () => {
  test('a multi-word name is never re-cased', () => {
    const target = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      mcp: { expose: true },
      handle: () => ({ id: POST_ID, published: true }),
    }).named('updateUserProfile');
    expect(describeAction(target).mcp.tool).toBe('updateUserProfile');
    expect(toOpenApiOperation(target)['x-ultimate']['mcpTool']).toBe('updateUserProfile');
  });
});
