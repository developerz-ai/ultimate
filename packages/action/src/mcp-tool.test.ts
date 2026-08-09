import { describe, expect, test } from 'bun:test';
import { createContext, runWithContext, userActor } from '@ultimat3/core';
import { createRequestContext, defineHttpConfig, UltimateRequest } from '@ultimat3/http';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { toRoute } from './http';
import { isExposed, toMcpTool, toMcpTools } from './mcp-tool';

const Input = t.object({ postId: t.uuid });
const Output = t.object({ id: t.uuid, published: t.boolean });
const POST_ID = '00000000-0000-4000-8000-0000000000aa';

/** No actor: core's anonymous actor is what an unauthenticated request carries. */
const anonymous = createContext({});
const editorActor = { ...userActor({ id: 'u1' }), permissions: ['post:publish'] };
const editor = createContext({ actor: editorActor });

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
  const config = defineHttpConfig({ dev: true });
  const rctx = createRequestContext({ url, method: 'POST', role: 'web', config });
  const raw = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { request: new UltimateRequest(raw, rctx), rctx };
}

describe('one authz system', () => {
  test('the HTTP route and the MCP tool run the same policy evaluation', async () => {
    const { target, seen } = defineCounted();
    const route = toRoute(target);
    const { request, rctx } = requestFor('/api/posts/publish', { postId: POST_ID });

    const response = await runWithContext(anonymous, () => route.handler(request, rctx));
    const denial = await runWithContext(anonymous, () =>
      toMcpTool(target)
        .invoke({ postId: POST_ID })
        .catch((error: unknown) => error),
    );

    // Same policy object, same subject, same verdict — the surface only changes how
    // the denial is rendered (problem+json here, tool content there).
    // No actor at all, so the permission clause short-circuits before the predicate.
    expect(seen).toEqual([]);
    expect(response.status).toBe(401);
    expect((denial as { code?: string }).code).toBe('X_UNAUTHENTICATED');
  });

  test('an authorized actor runs the same predicate once per surface', async () => {
    const { target, seen } = defineCounted();
    const route = toRoute(target);
    const { request, rctx } = requestFor('/api/posts/publish', { postId: POST_ID });

    const response = await runWithContext(editor, () => route.handler(request, rctx));
    const viaMcp = await runWithContext(editor, () =>
      toMcpTool(target).invoke({ postId: POST_ID }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: POST_ID, published: true });
    expect(viaMcp).toEqual({ id: POST_ID, published: true });
    // One evaluation per call, both with the same actor: one authz system.
    expect(seen).toEqual([editorActor, editorActor]);
  });

  test('the tool descriptor mirrors the action declaration', () => {
    const { target } = defineCounted();
    const tool = toMcpTool(target);
    expect(tool.name).toBe('publish_post');
    expect(tool.action).toBe('publishPost');
    expect(tool.inputSchema['type']).toBe('object');
  });
});

describe('exposure is opt-in', () => {
  const declaring = (mcp?: { expose: boolean }) =>
    action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      ...(mcp === undefined ? {} : { mcp }),
      handle: () => ({ id: POST_ID, published: true }),
    }).named('publishPost');

  test('an action with no mcp block is NOT a tool — writing one grants no agent capability', () => {
    expect(isExposed(declaring())).toBe(false);
    expect(toMcpTools([declaring()])).toEqual([]);
  });

  test('expose: false is not a tool either', () => {
    expect(isExposed(declaring({ expose: false }))).toBe(false);
  });

  test('a literal expose: true is the whole opt-in', () => {
    expect(isExposed(declaring({ expose: true }))).toBe(true);
    expect(toMcpTools([declaring({ expose: true })]).map((tool) => tool.action)).toEqual([
      'publishPost',
    ]);
  });
});
