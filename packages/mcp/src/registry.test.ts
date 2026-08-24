// The catalog and the first two security outcomes: visibility (role/predicate) and the
// resolve() ordering that must never leak a hidden tool's existence via a different error.

import { describe, expect, test } from 'bun:test';
import { agentActor, isUltimateError } from '@ultimat3/core';
import type { AnyMcpTool, McpCaller } from './registry';
import { jsonResult, ToolRegistry, textResult, visibleToCaller } from './registry';
import type { JsonSchema } from './wire';

const NO_ARGS: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };
const STRING_ARG: JsonSchema = {
  type: 'object',
  properties: { name: { type: 'string' } },
  required: ['name'],
  additionalProperties: false,
};

function caller(input: { role?: string; scopes?: readonly string[] } = {}): McpCaller {
  const actor = agentActor({ id: 'agent-1' });
  const scopes = new Set(input.scopes ?? []);
  return input.role === undefined ? { actor, scopes } : { actor, scopes, role: input.role };
}

function tool(overrides: Partial<AnyMcpTool> & { name: string }): AnyMcpTool {
  return {
    description: 'a tool',
    inputSchema: NO_ARGS,
    async handle() {
      return textResult('ok');
    },
    ...overrides,
  };
}

/** App code failing for an ordinary reason: a missing actor, a registry miss, a cold cache. */
function throwingVisibility(): boolean {
  throw new TypeError('visibility predicate blew up');
}

describe('visibleToCaller', () => {
  test('no visibleTo means everyone, including a roleless caller', () => {
    expect(visibleToCaller(tool({ name: 'open' }), caller())).toBe(true);
  });

  test('a role list admits a matching role and refuses a roleless caller (fail-closed)', () => {
    const t = tool({ name: 'admin.only', visibleTo: ['admin'] });
    expect(visibleToCaller(t, caller({ role: 'admin' }))).toBe(true);
    expect(visibleToCaller(t, caller({ role: 'support' }))).toBe(false);
    expect(visibleToCaller(t, caller())).toBe(false);
  });

  test('a predicate decides from the caller only, never from call arguments', () => {
    const t = tool({
      name: 'predicate.gated',
      visibleTo: (who) => who.actor.id === 'agent-allowed',
    });
    expect(visibleToCaller(t, caller())).toBe(false);
    const allowed: McpCaller = { actor: agentActor({ id: 'agent-allowed' }), scopes: new Set() };
    expect(visibleToCaller(t, allowed)).toBe(true);
  });

  test('a throwing predicate denies rather than escaping', () => {
    const t = tool({ name: 'boom', visibleTo: throwingVisibility });
    expect(visibleToCaller(t, caller({ role: 'admin' }))).toBe(false);
  });

  test('a truthy non-boolean does not widen the gate — only a literal true admits', () => {
    // A JS caller (or a predicate returning the permission it matched) must not be an "allow".
    // `@ts-expect-error` IS the first half of the assertion: `McpVisibility` refuses a predicate
    // that answers anything but `boolean`, so a typed app cannot write this. What the runtime
    // check below adds is the untyped caller the type system cannot reach — drop the `=== true`
    // in `visibleToCaller` and this test goes red while the directive stays needed.
    // @ts-expect-error a predicate returning a string is not assignable to McpVisibility
    const truthy = tool({ name: 'truthy', visibleTo: () => 'admin' });
    expect(visibleToCaller(truthy, caller({ role: 'admin' }))).toBe(false);
  });
});

describe('ToolRegistry.register', () => {
  test('registering the same name twice throws the CODED error, not a bare Error', () => {
    // The twin, `ResourceRegistry.register`, throws `X_MCP_RESOURCE_DUPLICATE` and
    // `packages/mcp/CLAUDE.md` says this one answers "the name is taken" the same way. It did
    // not: a file-private `class McpDuplicateToolError extends Error` carried no code, so
    // `x errors explain` could not answer it and the CLI mapped it to X_CLI_UNEXPECTED with
    // `fix: x doctor --json`, discarding the real cause.
    const registry = new ToolRegistry();
    registry.register(tool({ name: 'dup' }));

    let thrown: unknown;
    try {
      registry.register(tool({ name: 'dup' }));
    } catch (error) {
      thrown = error;
    }

    expect(isUltimateError(thrown) ? thrown.code : thrown).toBe('X_MCP_TOOL_DUPLICATE');
    expect(isUltimateError(thrown) ? thrown.cause : '').toContain('dup');
    // The first registration stands — a refusal that half-applied would be its own surprise.
    expect(registry.get('dup')).toBeDefined();
  });

  test('registerAll registers every tool and returns the registry for chaining', () => {
    const registry = new ToolRegistry();
    const result = registry.registerAll([tool({ name: 'a' }), tool({ name: 'b' })]);
    expect(result).toBe(registry);
    expect(registry.get('a')).toBeDefined();
    expect(registry.get('b')).toBeDefined();
  });

  test('get is a raw lookup with no gate applied', () => {
    const registry = new ToolRegistry();
    registry.register(tool({ name: 'hidden', visibleTo: ['admin'] }));
    expect(registry.get('hidden')).toBeDefined();
  });
});

describe('ToolRegistry.list / names', () => {
  test('list is name-sorted regardless of registration order', () => {
    const registry = new ToolRegistry();
    registry.registerAll([tool({ name: 'zebra' }), tool({ name: 'apple' })]);
    expect(registry.names()).toEqual(['apple', 'zebra']);
  });

  test('list with no caller returns everything, gated or not', () => {
    const registry = new ToolRegistry();
    registry.registerAll([
      tool({ name: 'open' }),
      tool({ name: 'admin.only', visibleTo: ['admin'] }),
    ]);
    expect(registry.names()).toEqual(['admin.only', 'open']);
  });

  test('list with a caller filters to what that caller may see', () => {
    const registry = new ToolRegistry();
    registry.registerAll([
      tool({ name: 'open' }),
      tool({ name: 'admin.only', visibleTo: ['admin'] }),
    ]);
    expect(registry.names(caller())).toEqual(['open']);
    expect(registry.names(caller({ role: 'admin' }))).toEqual(['admin.only', 'open']);
  });

  test('a tool whose predicate throws is hidden, and the rest of the catalog survives', () => {
    const registry = new ToolRegistry();
    registry.registerAll([
      tool({ name: 'open' }),
      tool({ name: 'boom', visibleTo: throwingVisibility }),
      tool({ name: 'zebra' }),
    ]);
    // One broken audience must not empty the catalog — that would be a denial of service
    // dressed up as a security control.
    expect(registry.names(caller({ role: 'admin' }))).toEqual(['open', 'zebra']);
  });

  test('each entry is a complete, standalone row', () => {
    const registry = new ToolRegistry();
    registry.register(tool({ name: 'echo', description: 'echoes', inputSchema: STRING_ARG }));
    expect(registry.list()).toEqual([
      { name: 'echo', description: 'echoes', inputSchema: STRING_ARG },
    ]);
  });
});

describe('ToolRegistry.resolve ordering: visibility -> scope -> args -> ok', () => {
  test('an absent tool and a role-hidden tool answer the same not-found kind', () => {
    const registry = new ToolRegistry();
    registry.register(tool({ name: 'admin.only', visibleTo: ['admin'] }));
    expect(registry.resolve('missing', {}, caller())).toEqual({
      kind: 'not-found',
      name: 'missing',
    });
    expect(registry.resolve('admin.only', {}, caller())).toEqual({
      kind: 'not-found',
      name: 'admin.only',
    });
  });

  test('a throwing predicate resolves not-found, indistinguishable from an absent tool', () => {
    const registry = new ToolRegistry();
    registry.register(tool({ name: 'boom', visibleTo: throwingVisibility }));
    // Propagating the throw would answer -32603 where a hidden tool answers -32601, and that
    // difference is what a prober reads as "this tool exists".
    expect(registry.resolve('boom', {}, caller({ role: 'admin' }))).toEqual({
      kind: 'not-found',
      name: 'boom',
    });
  });

  test('a visible tool whose scope the token lacks is scope-denied, not not-found', () => {
    const registry = new ToolRegistry();
    registry.register(tool({ name: 'reads', scope: 'dev:read' }));
    expect(registry.resolve('reads', {}, caller())).toEqual({
      kind: 'scope-denied',
      name: 'reads',
      scope: 'dev:read',
    });
    expect(registry.resolve('reads', {}, caller({ scopes: ['dev:read'] }))).toMatchObject({
      kind: 'ok',
    });
  });

  test('scope check runs before argument validation', () => {
    const registry = new ToolRegistry();
    registry.register(tool({ name: 'strict', scope: 'dev:write', inputSchema: STRING_ARG }));
    // Bad args AND missing scope: the caller learns about the scope, not the shape.
    expect(registry.resolve('strict', {}, caller())).toEqual({
      kind: 'scope-denied',
      name: 'strict',
      scope: 'dev:write',
    });
  });

  test('invalid arguments are reported once the gates pass', () => {
    const registry = new ToolRegistry();
    registry.register(tool({ name: 'echo', inputSchema: STRING_ARG }));
    const resolved = registry.resolve('echo', {}, caller());
    expect(resolved.kind).toBe('invalid-args');
    if (resolved.kind === 'invalid-args') {
      expect(resolved.issues).toEqual([{ path: 'name', message: 'is required' }]);
    }
  });

  test('a fully valid call resolves ok with the coerced args and the tool itself', () => {
    const registry = new ToolRegistry();
    const t = tool({ name: 'echo', inputSchema: STRING_ARG });
    registry.register(t);
    const resolved = registry.resolve('echo', { name: 'hi' }, caller());
    expect(resolved).toEqual({ kind: 'ok', tool: t, args: { name: 'hi' } });
  });

  test('a missing rawArgs defaults to an empty object rather than throwing', () => {
    const registry = new ToolRegistry();
    // The registered instance, not `registry.get()`: `get` answers `AnyMcpTool | undefined`, so
    // asserting against it would pass on a resolution that handed back nothing at all.
    const t = tool({ name: 'open' });
    registry.register(t);
    expect(registry.resolve('open', undefined, caller())).toEqual({
      kind: 'ok',
      tool: t,
      args: {},
    });
  });
});

describe('ToolRegistry.verbClass', () => {
  test('an unknown tool bills the strict write bucket, fail-closed', () => {
    const registry = new ToolRegistry();
    expect(registry.verbClass('nope')).toBe('write');
  });

  test('destructive true is write, everything else is read', () => {
    const registry = new ToolRegistry();
    registry.registerAll([tool({ name: 'reads' }), tool({ name: 'writes', destructive: true })]);
    expect(registry.verbClass('reads')).toBe('read');
    expect(registry.verbClass('writes')).toBe('write');
  });
});

describe('textResult / jsonResult', () => {
  test('textResult without isError omits the flag entirely', () => {
    const result = textResult('hello');
    expect(result).toEqual({ content: [{ type: 'text', text: 'hello' }] });
    expect('isError' in result).toBe(false);
  });

  test('textResult with isError true sets the flag', () => {
    expect(textResult('bad', true)).toEqual({
      content: [{ type: 'text', text: 'bad' }],
      isError: true,
    });
  });

  test('jsonResult renders stable, diffable 2-space JSON', () => {
    const result = jsonResult({ b: 1, a: 2 });
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ b: 1, a: 2 }, null, 2) },
    ]);
  });

  // The value is an ACTION's return value — `toolFromAction` hands `primitive.run`'s output
  // straight here — so `JSON.stringify`'s two non-string answers are both reachable from an app:
  // `undefined` for a handler that returns nothing, and a throw on a bigint, a cycle or a
  // `toJSON` of its own. A `ContentBlock.text` that is not a string is an invalid MCP frame, and
  // a throw here escapes the server's own catch as a bug it did not cause.
  /**
   * **The explicit timeout is measured, not padding.** `JSON.stringify(cycle, null, 2)` takes
   * ~4.6s in Bun 1.4 before it throws — the whole of this test's cost, the other two values are
   * ~0.3ms each — so on the 5000ms default it flips red under any concurrent load with nothing in
   * the diff to explain it. The seconds belong to the runtime, not to this assertion.
   *
   * It is also a real property of `jsonResult`: a tool returning a cyclic value blocks the event
   * loop for those seconds before the `isError` block is rendered. Correct, and slow.
   */
  test('a tool result that is not JSON becomes an isError block, never a throw', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    for (const value of [
      { total: 10n },
      cycle,
      {
        toJSON: () => {
          throw new Error('no');
        },
      },
    ]) {
      const result = jsonResult(value);
      expect(result.isError).toBe(true);
      // Narrowed, not cast: `ContentBlock` is a union, and a `resource` block here would be as
      // wrong an answer as a non-string `text`. The `typeof` check stays — narrowing proves the
      // declared type, and this proves the value.
      const first = result.content[0];
      expect(first?.type).toBe('text');
      const text = first?.type === 'text' ? first.text : undefined;
      expect(typeof text).toBe('string');
      expect(text).toContain('not JSON');
    }
  }, 30_000);

  test('a tool that returns nothing renders null, not a block with no text', () => {
    const result = jsonResult(undefined);
    expect(result.content).toEqual([{ type: 'text', text: 'null' }]);
    expect('isError' in result).toBe(false);
  });
});
