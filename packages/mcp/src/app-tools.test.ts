// The contract for `defineAppMcp`'s three authoring forms. The load-bearing assertion is
// "one authz system": a hand-written tool and an action holding the SAME permission must
// reach the same decision, for the same actor, with the same code.

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
import type { AnyMcpTool, McpCaller, McpToolResult } from './registry';
import { jsonResult } from './registry';

const owner = agentActor({ id: 'a1', orgId: 'o1', roles: ['owner'] });
const guest = agentActor({ id: 'a2', orgId: 'o1', roles: ['guest'] });

const caller = (actor: Actor): McpCaller => ({ actor, scopes: new Set<string>() });

/** Every tool runs inside a request; the child context the projection opens needs a parent. */
const inRequest = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(createContext({}), fn);

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
  if (tool === undefined) throw new TypeError(`no tool "${name}" in ${tools.map((x) => x.name)}`);
  return tool;
};

const codeOfRejection = async (promise: Promise<unknown>): Promise<string | null> =>
  promise.then(
    () => null,
    (error: { code?: string }) => error.code ?? 'unknown',
  );

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
      additionalProperties: false,
    });
    // Policy is the only gate; a scope would be a second one and the two would drift.
    expect(tool.scope).toBeUndefined();
    expect(tool.destructive).toBe(false);
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
    const tool = byName(defineAppMcp({ tools: { seatReport } }).tools, 'seatReport');

    const result = await inRequest(() => tool.handle({ orgId: 'o1' }, caller(owner)));

    expect(JSON.parse(textOf(result))).toEqual({ used: 3, actingAs: 'a1' });
  });

  test('a tool declared without a policy is refused at boot, not at first call', () => {
    // The authoring type requires `policy`; this is the JS caller that ignored it.
    const tools = { unsafe: { description: 'no gate', input: t.object({}), handle: () => null } };

    expect(() => defineAppMcp({ tools } as Parameters<typeof defineAppMcp>[0])).toThrow(
      'X_MCP_TOOL_UNSAFE',
    );
  });

  test('the ready-McpTool array form still works, untouched', async () => {
    const ready: AnyMcpTool = {
      name: 'ping',
      description: 'pong',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handle: async () => jsonResult('pong'),
    };

    const mcp = defineAppMcp({ tools: [ready] });

    expect(mcp.tools).toEqual([ready]);
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
      publishPost({ orgId: 'o1' }, { ctx: createContext({ actor: guest }) }),
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

  /** `@ultimat3/query`'s def type has no `mcp` field yet, so an author attaches it. */
  const registerFeed = (name: string, mcp?: { expose: boolean; description?: string }): void => {
    const feed = query({
      input: t.object({}),
      policy: can('post:read'),
      sql: () => from<{ id: string }>('posts', [{ id: 'p1' }]),
    });
    if (mcp !== undefined) Object.assign(feed.def, { mcp });
    registerQuery(name, feed);
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
      additionalProperties: false,
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

  test('a record tool sits alongside the projected ones', () => {
    registerActions();

    const mcp = defineAppMcp({ include: 'exposed', tools: { seatReport } });

    expect(mcp.tools.map((tool) => tool.name)).toEqual(['publishPost', 'seatReport']);
  });
});

describe('prompts', () => {
  test('a path becomes a named prompt; an object passes through', async () => {
    const mcp = defineAppMcp({
      prompts: [
        'apps/web/app/posts/prompts/summarize.v3.md',
        { name: 'triage', description: 'Triage a comment thread.' },
      ],
    });

    const response = await mcp.server.handle(
      { jsonrpc: '2.0', id: 1, method: 'prompts/list' },
      caller(owner),
    );

    expect(response?.result).toEqual({
      prompts: [
        {
          // The version stays in the name: `summarize.v2` and `summarize.v3` are two prompts.
          name: 'summarize.v3',
          description: 'Versioned prompt artifact: apps/web/app/posts/prompts/summarize.v3.md',
        },
        { name: 'triage', description: 'Triage a comment thread.' },
      ],
    });
  });
});
