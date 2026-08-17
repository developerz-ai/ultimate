import { describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import type { ProjectablePrimitive } from './from-action';
import { toolFromAction, toolsFrom, toolsListed } from './from-action';
import type { McpCaller } from './registry';

const human = { kind: 'user', id: 'u1' } as unknown as Actor;
const robot = { kind: 'agent', id: 'a1', onBehalfOf: 'u1' } as unknown as Actor;

interface Decision {
  readonly actorKind: string;
  readonly allowed: boolean;
}

/**
 * Stands in for `@ultimat3/policy`'s `evaluate`. The point of the test is not what this
 * decides but that BOTH surfaces reach it through the same `run`, so a change here cannot
 * apply to one surface and not the other.
 */
function makeAction() {
  const decisions: Decision[] = [];
  const action: ProjectablePrimitive = {
    name: 'publishPost',
    mcp: { expose: true, description: 'Publish a draft post' },
    mutates: true,
    inputJsonSchema: {
      type: 'object',
      properties: { postId: { type: 'string' }, notify: { type: 'boolean', default: true } },
      required: ['postId'],
      additionalProperties: false,
    },
    async run({ input, actor }) {
      // The ONE gate. HTTP and MCP both arrive here.
      const kind = (actor as { kind: string }).kind;
      const allowed = kind === 'user';
      decisions.push({ actorKind: kind, allowed });
      if (!allowed)
        throw Object.assign(new Error('denied'), {
          code: 'X_FORBIDDEN',
          cause: `actor kind "${kind}" may not publish`,
          fix: 'grant post:publish to agents in policy.ts',
        });
      return { id: (input as { postId: string }).postId, published: true };
    },
  };
  return { action, decisions };
}

const caller = (actor: Actor): McpCaller => ({ actor, scopes: new Set<string>() });

describe('one authz system, two surfaces', () => {
  test('HTTP and MCP reach the identical policy decision for the same actor', async () => {
    const { action, decisions } = makeAction();
    const tool = toolFromAction(action);
    const input = { postId: 'p1', notify: false };

    // Surface 1: the seam directly, standing in for the HTTP route — which reaches the same
    // `invoke` this fake's `run` replaces. (The route calls `invoke`, never an `action.run`.)
    const viaHttp = await action.run({ input, actor: human });
    // Surface 2: what the MCP tool does.
    const viaMcp = await tool.handle(input, caller(human));

    expect(viaHttp).toEqual({ id: 'p1', published: true });
    expect(JSON.parse((viaMcp.content[0] as { text: string }).text)).toEqual({
      id: 'p1',
      published: true,
    });
    // Same gate, once per call, with the same subject — not two authz systems agreeing.
    expect(decisions).toEqual([
      { actorKind: 'user', allowed: true },
      { actorKind: 'user', allowed: true },
    ]);
  });

  test('a denial on HTTP is the same denial on MCP, surfaced as an isError result', async () => {
    const { action, decisions } = makeAction();
    const tool = toolFromAction(action);
    const input = { postId: 'p1', notify: false };

    await expect(action.run({ input, actor: robot })).rejects.toThrow('denied');
    // The MCP tool does not catch policy failures itself; the server maps a thrown
    // framework error to an isError result. Here we assert the throw reaches the boundary.
    await expect(tool.handle(input, caller(robot))).rejects.toThrow('denied');
    expect(decisions.every((d) => !d.allowed)).toBe(true);
  });

  test('a projected tool declares NO scope — the action policy is the only gate', () => {
    const { action } = makeAction();
    const tool = toolFromAction(action);
    expect(tool.scope).toBeUndefined();
    expect(tool.name).toBe('publishPost');
    expect(tool.description).toBe('Publish a draft post');
    expect(tool.destructive).toBe(true);
  });
});

describe('projection is opt-in', () => {
  test('only primitives with mcp.expose are projected, in name order', () => {
    const { action } = makeAction();
    const hidden: ProjectablePrimitive = {
      name: 'deleteEverything',
      async run() {
        return null;
      },
    };
    const readOnly: ProjectablePrimitive = {
      name: 'aFeed',
      mcp: { expose: true },
      mutates: false,
      async run() {
        return [];
      },
    };
    const tools = toolsFrom([action, hidden, readOnly]);
    expect(tools.map((t) => t.name)).toEqual(['aFeed', 'publishPost']);
    expect(tools[0]?.destructive).toBe(false);
  });
});

describe('a list the author wrote out is refused, not filtered', () => {
  const undeclared = (name: string, mcp?: { expose: boolean }): ProjectablePrimitive => ({
    name,
    ...(mcp === undefined ? {} : { mcp }),
    async run() {
      return null;
    },
  });

  test('an undeclared primitive is X_MCP_TOOL_UNDECLARED, where toolsFrom would drop it', () => {
    const list = [undeclared('deleteEverything')];

    // The difference between the two projections, stated as one pair of assertions.
    expect(toolsFrom(list)).toEqual([]);
    expect(() => toolsListed(list)).toThrow('X_MCP_TOOL_UNDECLARED');
  });

  test('`expose: false` is undeclared too — only a literal opt-in counts', () => {
    expect(() => toolsListed([undeclared('optedOut', { expose: false })])).toThrow(
      'X_MCP_TOOL_UNDECLARED',
    );
  });

  test('every offender is named in one throw, so one edit closes all of them', () => {
    const error = (() => {
      try {
        toolsListed([undeclared('alpha'), makeAction().action, undeclared('omega')]);
        return null;
      } catch (thrown) {
        return thrown as { code: string; cause: string; names: readonly string[] };
      }
    })();

    expect(error?.code).toBe('X_MCP_TOOL_UNDECLARED');
    expect(error?.names).toEqual(['alpha', 'omega']);
    // The exposed one is not slandered by the message that names its neighbours.
    expect(error?.cause).toBe('listed in defineAppMcp but never declared mcp.expose: alpha, omega');
  });

  test('an all-exposed list projects exactly as toolsFrom does — same tools, same order', () => {
    const list = [
      makeAction().action,
      { name: 'aFeed', mcp: { expose: true }, mutates: false, run: async () => [] },
    ];

    expect(toolsListed(list).map((t) => t.name)).toEqual(toolsFrom(list).map((t) => t.name));
    expect(toolsListed(list).map((t) => t.name)).toEqual(['aFeed', 'publishPost']);
  });
});
