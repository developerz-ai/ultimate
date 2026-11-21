// The contract for `defineAppMcp`'s three authoring forms. The load-bearing assertion is
// "one authz system": a hand-written tool and an action holding the SAME permission must
// reach the same decision, for the same actor, with the same code.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { action, resetActions } from '@ultimat3/action';
import { registerAction } from '@ultimat3/action/loader';
import type { Actor, McpExposureDeclaration } from '@ultimat3/core';
import { agentActor, ctxOf, runWithContext } from '@ultimat3/core';
import {
  can,
  clearPermissions,
  clearRoles,
  definePermissions,
  defineRoles,
} from '@ultimat3/policy';
import { from, query, resetQueries } from '@ultimat3/query';
import { registerQuery } from '@ultimat3/query/loader';
import { t } from '@ultimat3/schema';
import { defineAppMcp } from './app-tools';
import type { ProjectablePrimitive } from './from-action';
import type { AnyMcpTool, McpCaller, McpToolResult } from './registry';
import { jsonResult } from './registry';
import type { JsonSchema } from './wire';

const owner = agentActor({ id: 'a1', orgId: 'o1', roles: ['owner'] });
const guest = agentActor({ id: 'a2', orgId: 'o1', roles: ['guest'] });

const caller = (actor: Actor): McpCaller => ({ actor, scopes: new Set<string>() });

/** Every tool runs inside a request; the child context the projection opens needs a parent. */
const inRequest = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(ctxOf({}), fn);

/** The authoring shape the reference app uses: key = name, Standard Schema, permission. */
const seatReport = {
  description: 'Seats used, remaining and the plan limit. Read-only.',
  input: t.object({ orgId: t.string }),
  policy: 'org:administer',
  destructive: false,
  handle({ ctx }: { input: unknown; ctx: { actor: Actor } }) {
    return { used: 3, actingAs: ctx.actor.id };
  },
} as const;

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

const textOf = (result: McpToolResult): string =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');

const byName = (tools: readonly AnyMcpTool[], name: string): AnyMcpTool => {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) expect.unreachable(`no tool "${name}" in ${tools.map((x) => x.name)}`);
  return tool;
};

const codeOfRejection = async (promise: Promise<unknown>): Promise<string | null> =>
  promise.then(
    () => null,
    (error: { code?: string }) => error.code ?? 'unknown',
  );

/** A boot-time refusal is only useful if it carries the contract — assert on the fields. */
interface ThrownContract {
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
}

const codeAndCause = (fn: () => unknown): ThrownContract | null => {
  try {
    fn();
    return null;
  } catch (thrown) {
    return thrown as ThrownContract;
  }
};

describe('tools as a named record', () => {
  test('the record key is the tool name and the schema becomes the wire inputSchema', () => {
    const mcp = defineAppMcp({ tools: { seatReport } });

    expect(mcp.tools.map((tool) => tool.name)).toEqual(['seatReport']);
    const tool = byName(mcp.tools, 'seatReport');
    expect(tool.description).toBe(seatReport.description);
    expect(tool.inputSchema).toEqual({
      type: 'object',
      properties: { orgId: { type: 'string', minLength: 1 } },
      required: ['orgId'],
      additionalProperties: true,
    });
    // Policy is the only gate; a scope would be a second one and the two would drift.
    expect(tool.scope).toBeUndefined();
    expect(tool.destructive).toBe(false);
  });

  test("a per-argument .describe() reaches tools/list as that property's description", async () => {
    const described = {
      ...seatReport,
      input: t.object({ orgId: t.string.describe('the org whose seats to count') }),
    };
    const mcp = defineAppMcp({ tools: { seatReport: described } });
    const listed = await mcp.server.handle(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      caller(owner),
    );
    const result = listed?.result as { tools: { name: string; inputSchema: JsonSchema }[] };
    expect(result.tools[0]?.inputSchema.properties?.['orgId']?.description).toBe(
      'the org whose seats to count',
    );
  });

  test('bodyLimitBytes is forwarded to the route, so the 413 fix line can be followed', async () => {
    const mcp = defineAppMcp({
      tools: { seatReport },
      resolveToken: () => ({ actor: owner, scopes: new Set<string>() }),
      bodyLimitBytes: 64,
    });
    const response = await mcp.route?.handle(
      new Request('http://local/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', pad: 'x'.repeat(256) }),
      }),
    );
    expect(response?.status).toBe(413);
    const payload = (await response?.json()) as { error: { data: { code: string } } };
    expect(payload.error.data.code).toBe('X_MCP_BODY_TOO_LARGE');
  });

  test('an unmarked tool is metered as a write — forgetting the flag costs speed, not safety', () => {
    const mcp = defineAppMcp({
      tools: {
        risky: {
          description: 'unmarked',
          input: t.object({}),
          policy: 'org:administer',
          handle: () => null,
        },
      },
    });
    expect(byName(mcp.tools, 'risky').destructive).toBe(true);
  });

  test('the handler runs as the MCP caller, not as the ambient request actor', async () => {
    const seen: unknown[] = [];
    const report = {
      ...seatReport,
      handle: (args: Parameters<typeof seatReport.handle>[0]) => {
        seen.push(args.input);
        return seatReport.handle(args);
      },
    };
    const { server } = defineAppMcp({ tools: { seatReport: report } });
    const request = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'seatReport', arguments: { orgId: 'o1', extra: true } },
    };
    const response = await inRequest(() => server.handle(request, caller(owner)));
    expect(response?.error).toBeUndefined();
    const result = response?.result as McpToolResult;
    expect(result.isError).toBeUndefined();
    expect(seen).toEqual([{ orgId: 'o1' }]);
    expect(JSON.parse(textOf(result))).toEqual({ used: 3, actingAs: 'a1' });
  });

  // Two authoring forms, two answers: a DERIVED schema is open (parse takes a stray key and drops
  // it), a HAND-WRITTEN one is republished byte for byte and the dispatcher performs its refusal.
  test('a derived schema is open and a hand-written one stays closed, and tools/call agrees', async () => {
    const call = async (
      mcp: ReturnType<typeof defineAppMcp>,
      name: string,
      args: Record<string, unknown>,
    ) => {
      const at = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } };
      return (await inRequest(() => mcp.server.handle(at, caller(owner))))?.result as McpToolResult;
    };

    const derived = defineAppMcp({ tools: { seatReport } });
    expect(byName(derived.tools, 'seatReport').inputSchema.additionalProperties).toBe(true);
    // The stray key is accepted at the boundary and dropped before the handler runs.
    const open = await call(derived, 'seatReport', { orgId: 'o1', extra: true });
    expect(JSON.parse(textOf(open))).toEqual({ used: 3, actingAs: 'a1' });

    // The ready-array form carries the literal the author wrote, untouched.
    const inputSchema: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };
    const closed: AnyMcpTool = {
      name: 'ping',
      description: 'pong',
      inputSchema,
      handle: async () => jsonResult('pong'),
    };
    const handWritten = defineAppMcp({ tools: [closed] });
    expect(byName(handWritten.tools, 'ping').inputSchema).toEqual(inputSchema);
    // `false` is a rejection its author wrote and the dispatcher performs; had the projection
    // widened this literal too, the call below would answer instead of refusing.
    const refused = await call(handWritten, 'ping', { extra: true });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('X_INPUT_INVALID');
  });

  test('a tool declared without a policy is refused at boot, not at first call', () => {
    // The authoring type requires `policy`; this is the JS caller that ignored it.
    const tools = { unsafe: { description: 'no gate', input: t.object({}), handle: () => null } };

    // `@ts-expect-error` is the first half of the claim: the authoring type REFUSES a tool with
    // no `policy`, so no typed app can write this. The throw is the second half, for the untyped
    // caller the type cannot reach — delete the boot-time check and this line goes red while the
    // directive stays needed.
    // @ts-expect-error a tool definition with no `policy` is not an AppToolDefinition
    expect(() => defineAppMcp({ tools })).toThrow('X_MCP_TOOL_UNSAFE');
  });

  test('the ready-McpTool array form still works, its declaration untouched', async () => {
    const ready: AnyMcpTool = {
      name: 'ping',
      description: 'pong',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handle: async () => jsonResult('pong'),
    };

    const mcp = defineAppMcp({ tools: [ready] });

    // All but `handle`, which asks the gate registered for its name at call time.
    const { handle: _ready, ...declared } = ready;
    expect(mcp.tools.map(({ handle: _projected, ...rest }) => rest)).toEqual([declared]);
    expect(textOf(await byName(mcp.tools, 'ping').handle({}, caller(owner)))).toBe('"pong"');
  });
});

describe('one authz system, not a second one for hand-written tools', () => {
  test('a tool and an action holding the same permission deny the same actor identically', async () => {
    const publishPost = registerAction(
      'publishPost',
      action({
        input: t.object({ orgId: t.string }),
        output: t.object({ ok: t.boolean }),
        policy: can('org:administer'),
        handle: () => ({ ok: true }),
      }),
    );
    const tool = byName(defineAppMcp({ tools: { seatReport } }).tools, 'seatReport');

    const viaAction = await codeOfRejection(
      publishPost({ orgId: 'o1' }, { ctx: ctxOf({ actor: guest }) }),
    );
    const viaTool = await inRequest(() =>
      codeOfRejection(tool.handle({ orgId: 'o1' }, caller(guest))),
    );

    expect(viaTool).toBe('X_FORBIDDEN');
    expect(viaTool).toBe(viaAction);
  });

  test('the permitted actor is allowed on the tool surface', async () => {
    const tool = byName(defineAppMcp({ tools: { seatReport } }).tools, 'seatReport');

    const result = await inRequest(() => tool.handle({ orgId: 'o1' }, caller(owner)));

    expect(result.isError).toBeUndefined();
  });
});

describe("include: 'exposed'", () => {
  const registerActions = (): void => {
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
    registerAction(
      'deleteEverything',
      action({
        input: t.object({}),
        output: t.object({ ok: t.boolean }),
        policy: can('post:publish'),
        handle: () => ({ ok: true }),
      }),
    );
  };

  /** `mcp:` is declared on the query, exactly as an author writes it. */
  const registerFeed = (name: string, mcp?: McpExposureDeclaration): void => {
    registerQuery(
      name,
      query({
        input: t.object({}),
        policy: can('post:read'),
        ...(mcp === undefined ? {} : { mcp }),
        sql: () => from<{ id: string }>('posts', [{ id: 'p1' }]),
      }),
    );
  };

  test('projects every opted-in primitive from the registries and nothing else', () => {
    registerActions();
    registerFeed('privateFeed');

    const mcp = defineAppMcp({ include: 'exposed' });

    // `deleteEverything` and `privateFeed` never declared expose; silence exposes nothing.
    expect(mcp.tools.map((tool) => tool.name)).toEqual(['publishPost']);
    const tool = byName(mcp.tools, 'publishPost');
    expect(tool.description).toBe('Publish a draft post');
    expect(tool.destructive).toBe(true);
    expect(tool.inputSchema).toEqual({
      type: 'object',
      properties: { postId: { type: 'string', minLength: 1 } },
      required: ['postId'],
      additionalProperties: true,
    });
  });

  test('an opted-in query is projected as a read, so it is metered as one', () => {
    registerFeed('orgFeed', { expose: true, description: 'The org feed' });

    const tool = byName(defineAppMcp({ include: 'exposed' }).tools, 'orgFeed');

    expect(tool.description).toBe('The org feed');
    expect(tool.destructive).toBe(false);
  });

  test('include is additive, and an explicitly listed primitive wins over the registry copy', () => {
    registerActions();
    const explicit = {
      name: 'publishPost',
      mcp: { expose: true, description: 'hand-tuned' },
      mutates: false,
      async run() {
        return { ok: true };
      },
    };
    const extra = {
      name: 'zLegacy',
      mcp: { expose: true },
      async run() {
        return null;
      },
    };

    const mcp = defineAppMcp({ include: 'exposed', actions: [explicit, extra] });

    expect([...mcp.tools.map((tool) => tool.name)].sort()).toEqual(['publishPost', 'zLegacy']);
    expect(byName(mcp.tools, 'publishPost').description).toBe('hand-tuned');
  });

  test('the default is unchanged: no include means no registry read', () => {
    registerActions();

    expect(defineAppMcp({}).tools).toEqual([]);
  });

  test('the registry sweep still passes over what never opted in — it is not a written list', () => {
    registerActions();
    registerFeed('privateFeed');

    // `deleteEverything` and `privateFeed` are undeclared and must NOT be an error here:
    // `include` reads every primitive the app registered, not a list anyone wrote out.
    expect(() => defineAppMcp({ include: 'exposed' })).not.toThrow();
  });

  test('a record tool sits alongside the projected ones', () => {
    registerActions();

    const mcp = defineAppMcp({ include: 'exposed', tools: { seatReport } });

    expect(mcp.tools.map((tool) => tool.name)).toEqual(['publishPost', 'seatReport']);
  });
});

describe('an undeclared primitive in a written-out list is a build error', () => {
  const primitive = (name: string, mcp?: { expose: boolean }): ProjectablePrimitive => ({
    name,
    ...(mcp === undefined ? {} : { mcp }),
    async run() {
      return null;
    },
  });

  test('a listed action without mcp.expose fails at boot, naming the action', () => {
    const thrown = codeAndCause(() => defineAppMcp({ actions: [primitive('deleteEverything')] }));

    expect(thrown?.code).toBe('X_MCP_TOOL_UNDECLARED');
    expect(thrown?.cause).toContain('deleteEverything');
    // Exposure belongs next to the policy, so the fix points there — not at this file.
    expect(thrown?.fix).toContain('mcp: { expose: true');
  });

  test('a listed query is held to the same rule', () => {
    expect(() => defineAppMcp({ queries: [primitive('privateFeed')] })).toThrow(
      'X_MCP_TOOL_UNDECLARED',
    );
  });

  test('one throw names every offender across BOTH arrays, so one edit closes all of them', () => {
    const thrown = codeAndCause(() =>
      defineAppMcp({
        actions: [primitive('deleteEverything'), primitive('publishPost', { expose: true })],
        queries: [primitive('privateFeed')],
      }),
    );

    expect(thrown?.code).toBe('X_MCP_TOOL_UNDECLARED');
    // Two `toolsListed` calls would throw on the action and never examine the queries — the
    // author fixes the actions, re-boots, and meets the same error again for the query.
    expect(thrown?.cause).toContain('deleteEverything');
    expect(thrown?.cause).toContain('privateFeed');
  });

  test('mcp: { expose: false } is refused as loudly as no mcp block at all', () => {
    expect(() => defineAppMcp({ actions: [primitive('optedOut', { expose: false })] })).toThrow(
      'X_MCP_TOOL_UNDECLARED',
    );
  });

  test('the server is never built: a catalog missing a listed tool must not reach a client', () => {
    registerAction(
      'publishPost',
      action({
        input: t.object({}),
        output: t.object({ ok: t.boolean }),
        policy: can('post:publish'),
        mcp: { expose: true, description: 'Publish a draft post' },
        handle: () => ({ ok: true }),
      }),
    );

    expect(() =>
      defineAppMcp({ include: 'exposed', actions: [primitive('deleteEverything')] }),
    ).toThrow('X_MCP_TOOL_UNDECLARED');
  });

  test('a listed primitive that DID opt in still projects — the happy path is untouched', () => {
    const mcp = defineAppMcp({ actions: [primitive('publishPost', { expose: true })] });

    expect(mcp.tools.map((tool) => tool.name)).toEqual(['publishPost']);
  });
});

describe('two primitives may not project to one tool name', () => {
  test('a record key colliding with a projected action is X_MCP_TOOL_DUPLICATE at boot', () => {
    registerAction(
      'seatReport',
      action({
        input: t.object({ orgId: t.string }),
        output: t.object({ ok: t.boolean }),
        policy: can('org:administer'),
        mcp: { expose: true, description: 'The action, not the hand-written tool' },
        handle: () => ({ ok: true }),
      }),
    );

    const thrown = codeAndCause(() => defineAppMcp({ include: 'exposed', tools: { seatReport } }));

    // An UltimateError, not a bare throw: an agent reading this gets `{ code, cause, fix }`.
    expect(thrown?.code).toBe('X_MCP_TOOL_DUPLICATE');
    expect(thrown?.cause).toContain('seatReport');
    expect(thrown?.fix).toContain('rename one');
  });

  test('the refusal names WHERE each copy came from, so the fix names a declaration site', () => {
    // The old `fix:` said "the primitive's export name, or the `tools` record key" — on the path
    // that most often raises it neither is the name that collided, so the reader was sent to two
    // places that do not hold it. Which list projected each copy is the one fact only the
    // projector knows, so it travels with the error.
    registerAction(
      'seatAudit',
      action({
        input: t.object({ orgId: t.string }),
        output: t.object({ ok: t.boolean }),
        policy: can('org:administer'),
        mcp: { expose: true, description: 'The action' },
        handle: () => ({ ok: true }),
      }),
    );

    const thrown = codeAndCause(() =>
      defineAppMcp({ include: 'exposed', tools: { seatAudit: seatReport } }),
    );

    expect(thrown?.cause).toContain('include:');
    expect(thrown?.cause).toContain('tools:');
    expect(thrown?.fix).toContain('seatAudit');
  });
});
