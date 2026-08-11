// `X_MCP_TOOL_UNDECLARED` over what an app actually writes — `actions: [publishPost]`.
//
// `app-tools.test.ts` proves the same gate over hand-built `ProjectablePrimitive` stand-ins.
// That was the ONLY value that could reach it until 2026-08: no `action()` or `query()`
// structurally satisfies `ProjectablePrimitive` (they carry `as`/`tool`, never `run`), so
// `defineAppMcp({ actions: [publishPost] })` was a TS2741 and the gate refused nothing an app
// could declare. A gate can only refuse what a declaration can reach — this file is the half
// that reaches it, and it is a real `action` and a real `query` throughout.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { action, registerAction, resetRegistry as resetActions } from '@ultimat3/action';
import type { Actor } from '@ultimat3/core';
import { agentActor, createContext, runWithContext } from '@ultimat3/core';
import {
  can,
  clearPermissions,
  clearRoles,
  definePermissions,
  defineRoles,
} from '@ultimat3/policy';
import { from, query, registerQuery, resetRegistry as resetQueries } from '@ultimat3/query';
import { t } from '@ultimat3/schema';
import { defineAppMcp } from './app-tools';
import type { ProjectablePrimitive } from './from-action';
import { asProjectable } from './projectable';
import type { McpCaller, McpToolResult } from './registry';

const owner = agentActor({ id: 'a1', orgId: 'o1', roles: ['owner'] });
const guest = agentActor({ id: 'a2', orgId: 'o1', roles: ['guest'] });

const caller = (actor: Actor): McpCaller => ({ actor, scopes: new Set<string>() });

/** Every tool runs inside a request; the child context the projection opens needs a parent. */
const inRequest = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(createContext({}), fn);

const textOf = (result: McpToolResult): string =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');

interface ThrownContract {
  readonly code?: string;
  readonly cause?: string;
  readonly fix?: string;
}

const codeAndCause = (fn: () => unknown): ThrownContract | null => {
  try {
    fn();
    return null;
  } catch (thrown) {
    return thrown as ThrownContract;
  }
};

/** Registered, so it carries the export name the tool is addressed by. */
const exposedAction = () =>
  registerAction(
    'publishPost',
    action({
      input: t.object({ postId: t.string }),
      output: t.object({ ok: t.boolean }),
      policy: can('post:publish'),
      mcp: { expose: true, description: 'Publish a draft post' },
      handle: () => ({ ok: true }),
    }),
  );

const undeclaredAction = () =>
  registerAction(
    'deleteEverything',
    action({
      input: t.object({}),
      output: t.object({ ok: t.boolean }),
      policy: can('org:administer'),
      handle: () => ({ ok: true }),
    }),
  );

const undeclaredQuery = () =>
  registerQuery(
    'privateFeed',
    query({
      input: t.object({}),
      policy: can('post:read'),
      sql: () => from<{ id: string }>('posts', [{ id: 'p1' }]),
    }),
  );

beforeEach(() => {
  definePermissions(['org:administer', 'post:publish', 'post:read']);
  defineRoles({ owner: { grants: ['org:administer', 'post:publish', 'post:read'] } });
});

afterEach(() => {
  resetActions();
  resetQueries();
  clearPermissions();
  clearRoles();
});

describe('a written-out list refuses a REAL primitive that never opted in', () => {
  test('a listed action without mcp.expose is X_MCP_TOOL_UNDECLARED, naming the action', () => {
    const thrown = codeAndCause(() => defineAppMcp({ actions: [undeclaredAction()] }));

    expect(thrown?.code).toBe('X_MCP_TOOL_UNDECLARED');
    expect(thrown?.cause).toContain('deleteEverything');
    // Exposure belongs next to the policy, so the fix points there — not at the MCP file.
    expect(thrown?.fix).toContain('mcp: { expose: true');
  });

  test('a listed query is held to the same rule', () => {
    expect(() => defineAppMcp({ queries: [undeclaredQuery()] })).toThrow('X_MCP_TOOL_UNDECLARED');
  });

  test('one throw names every offender across BOTH arrays', () => {
    const thrown = codeAndCause(() =>
      defineAppMcp({
        actions: [undeclaredAction(), exposedAction()],
        queries: [undeclaredQuery()],
      }),
    );

    expect(thrown?.code).toBe('X_MCP_TOOL_UNDECLARED');
    // Two `toolsListed` calls would throw on the actions and never examine the queries.
    expect(thrown?.cause).toContain('deleteEverything');
    expect(thrown?.cause).toContain('privateFeed');
  });

  test('the server is never built — a catalog missing a listed tool must not reach a client', () => {
    exposedAction();

    expect(() => defineAppMcp({ include: 'exposed', actions: [undeclaredAction()] })).toThrow(
      'X_MCP_TOOL_UNDECLARED',
    );
  });
});

describe('a written-out list of real primitives projects like the registry sweep', () => {
  test('an exposed action listed by hand becomes the tool it declares', () => {
    const mcp = defineAppMcp({ actions: [exposedAction()] });

    expect(mcp.tools.map((tool) => tool.name)).toEqual(['publishPost']);
    const tool = mcp.tools[0];
    expect(tool?.description).toBe('Publish a draft post');
    // An action mutates, so it is metered as expensive by default.
    expect(tool?.destructive).toBe(true);
    expect(tool?.inputSchema).toMatchObject({ type: 'object' });
  });

  test('the listed projection is byte-identical to what include: exposed produces', () => {
    const target = exposedAction();
    const strip = (tool: { name: string; description: string; destructive: boolean }) => ({
      name: tool.name,
      description: tool.description,
      destructive: tool.destructive,
    });

    const listed = defineAppMcp({ actions: [target] }).tools.map(strip);
    const swept = defineAppMcp({ include: 'exposed' }).tools.map(strip);

    // One adapter, two callers: writing a primitive out NAMES a tool, it never re-shapes one.
    expect(listed).toEqual(swept);
  });

  test('visibleTo declared on the action survives the written-out list', () => {
    const restricted = registerAction(
      'transferOrg',
      action({
        input: t.object({}),
        output: t.object({ ok: t.boolean }),
        policy: can('org:administer'),
        mcp: { expose: true, description: 'Transfer the org', visibleTo: ['owner'] },
        handle: () => ({ ok: true }),
      }),
    );

    const mcp = defineAppMcp({ actions: [restricted] });

    // Outcome 1 must be reachable through BOTH declaration routes, not just the sweep.
    expect(mcp.tools[0]?.visibleTo).toEqual(['owner']);
  });

  test('an exposed query listed by hand is projected as a read', async () => {
    const feed = registerQuery(
      'orgFeed',
      query({
        input: t.object({}),
        policy: can('post:read'),
        mcp: { expose: true, description: 'The org feed' },
        sql: () => from<{ id: string }>('posts', [{ id: 'p1' }]),
      }),
    );

    const mcp = defineAppMcp({ queries: [feed] });

    expect(mcp.tools.map((tool) => tool.name)).toEqual(['orgFeed']);
    // A query reads, so it is NOT metered as a destructive call.
    expect(mcp.tools[0]?.destructive).toBe(false);

    const result = await inRequest(
      () => mcp.tools[0]?.handle({}, caller(owner)) as Promise<McpToolResult>,
    );
    expect(textOf(result)).toContain('p1');
  });
});

describe('the listed primitive runs through the ONE authz path', () => {
  /** Driven over the wire, because it is `server.ts` that renders a denial into a result. */
  const call = (name: string, args: Record<string, unknown> = {}) => ({
    jsonrpc: '2.0' as const,
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });

  const toolResult = (response: { result?: unknown } | null) =>
    (response?.result ?? {}) as { isError?: boolean; content?: { text: string }[] };

  test('the action policy decides the tool call — no second check, same code', async () => {
    const server = defineAppMcp({ actions: [exposedAction()] }).server;

    const allowed = await inRequest(() =>
      server.handle(call('publishPost', { postId: 'p1' }), caller(owner)),
    );
    expect(toolResult(allowed).isError).toBeUndefined();

    const denied = await inRequest(() =>
      server.handle(call('publishPost', { postId: 'p1' }), caller(guest)),
    );
    // Outcome 3: not a JSON-RPC error, an isError RESULT carrying the action's own code —
    // the same denial `can('post:publish')` hands an HTTP call, from the same policy object.
    expect(denied?.error).toBeUndefined();
    expect(toolResult(denied).isError).toBe(true);
    expect(toolResult(denied).content?.[0]?.text ?? '').toContain('X_FORBIDDEN');
  });
});

describe('asProjectable', () => {
  test('an unregistered action is refused rather than projected as a nameless tool', () => {
    const orphan = action({
      input: t.object({}),
      output: t.object({ ok: t.boolean }),
      policy: can('post:publish'),
      mcp: { expose: true, description: 'Never handed to defineApi' },
      handle: () => ({ ok: true }),
    });

    // Loud, and named: a tool called '' is unaddressable by tools/call and by the scope map.
    expect(() => defineAppMcp({ actions: [orphan] })).toThrow('X_ACTION_UNREGISTERED');
  });

  test('a hand-built ProjectablePrimitive still passes through untouched', () => {
    const fake: ProjectablePrimitive = {
      name: 'seatReport',
      mcp: { expose: true, description: 'Built programmatically, as @ultimat3/admin does' },
      async run() {
        return { used: 3 };
      },
    };

    expect(asProjectable(fake)).toBe(fake);
    expect(defineAppMcp({ actions: [fake] }).tools.map((tool) => tool.name)).toEqual([
      'seatReport',
    ]);
  });

  test('a look-alike carrying kind: action is NOT taken for one', () => {
    // `isAction` reads @ultimat3/action's private declaration store, so a copied brand cannot
    // borrow `invoke`. It falls through as the projectable object it claims to be.
    const lookAlike = Object.assign(async () => ({ ok: true }), {
      kind: 'action' as const,
      mcp: { expose: true, description: 'A brand, not a declaration' },
      async run() {
        return { ok: true };
      },
    });
    Object.defineProperty(lookAlike, 'name', { value: 'notReallyAnAction' });

    expect(asProjectable(lookAlike)).toBe(lookAlike);
    // Projected verbatim: it never reaches `invoke`, so the brand buys it nothing.
    expect(defineAppMcp({ actions: [lookAlike] }).tools.map((tool) => tool.name)).toEqual([
      'notReallyAnAction',
    ]);
  });
});
