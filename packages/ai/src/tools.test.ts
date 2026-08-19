import { describe, expect, test } from 'bun:test';
import { action } from '@ultimat3/action';
import { agentActor, createContext, runWithContext } from '@ultimat3/core';
import { allow, forbidden } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { ProjectableAction } from './tools';
import { asProjectableAction, runLlmToolCall, toLlmTool, toLlmTools, toolLabel } from './tools';

const actor = agentActor({ id: 'agent-1' });

const projectable = (
  name: string,
  mcp?: ProjectableAction['mcp'],
  run?: ProjectableAction['run'],
): ProjectableAction => ({
  name,
  ...(mcp === undefined ? {} : { mcp }),
  inputJsonSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  run: run ?? (async ({ input }) => ({ ran: name, input })),
});

describe('toLlmTool', () => {
  test('the mcp description wins, then the primitive description, then a derived line', () => {
    expect(toLlmTool(projectable('publishPost', { expose: true, description: 'Publish' }))).toEqual(
      {
        name: 'publishPost',
        description: 'Publish',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        strict: true,
      },
    );
    expect(toLlmTool({ ...projectable('publishPost'), description: 'From the primitive' })).toEqual(
      expect.objectContaining({ description: 'From the primitive' }),
    );
    expect(toLlmTool(projectable('publishPost')).description).toBe('Run the "publishPost" action.');
  });

  test('an action with no input schema still projects a callable, empty object schema', () => {
    const tool = toLlmTool({ name: 'ping', run: async () => 'pong' });
    expect(tool.input_schema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
    expect(tool.strict).toBe(true);
  });
});

// The gateway offers the same tools MCP does, because both ask `isMcpExposed`. A second, looser
// rule here would hand an in-app agent a capability the external one is refused.
describe('exposure is opt-in, the same opt-in MCP reads', () => {
  test('only a literal expose: true reaches the model, in stable name order', () => {
    const tools = toLlmTools([
      projectable('publishPost', { expose: true }),
      projectable('deleteOrg'),
      projectable('archivePost', { expose: false }),
      projectable('inviteMember', { expose: true }),
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(['inviteMember', 'publishPost']);
  });

  test('an un-exposed action is unknown to a tool call, even by exact name', async () => {
    let ran = false;
    const actions = [
      projectable('deleteOrg', undefined, async () => {
        ran = true;
        return 'gone';
      }),
    ];
    const result = await runLlmToolCall(
      actions,
      { id: 'call-1', name: 'deleteOrg', input: { id: 'o1' } },
      actor,
    );
    expect(ran).toBe(false);
    expect(result).toEqual({
      toolUseId: 'call-1',
      content: 'unknown tool: deleteOrg',
      isError: true,
    });
  });

  test('an exposed action runs and its output comes back as JSON', async () => {
    const result = await runLlmToolCall(
      [projectable('publishPost', { expose: true })],
      { id: 'call-2', name: 'publishPost', input: { id: 'p1' } },
      actor,
    );
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual({ ran: 'publishPost', input: { id: 'p1' } });
  });
});

describe('runLlmToolCall renders a failure the model can act on', () => {
  // The real denial an action's policy gate throws, not a hand-rolled lookalike: a duck-typed
  // `{ code, cause, fix }` would keep passing after `PolicyError` stopped carrying one of them.
  test('a framework error keeps its code, cause and fix', async () => {
    const denied = projectable('publishPost', { expose: true }, async () => {
      throw forbidden('post:publish', 'actor lacks post:publish');
    });
    const result = await runLlmToolCall(
      [denied],
      { id: 'call-3', name: 'publishPost', input: { id: 'p1' } },
      actor,
    );
    expect(result).toEqual({
      toolUseId: 'call-3',
      content:
        'X_FORBIDDEN: post:publish denied: actor lacks post:publish ' +
        '(fix: x policy explain post:publish --json   # shows which clause decided and why)',
      isError: true,
    });
  });

  // A throw from outside the framework — an SDK, a driver — is what this branch exists for, so
  // the test has to raise one. It carries no `code`, which is the whole subject: an
  // `UltimateError` here would exercise the branch above instead.
  class ThirdPartySdkError extends Error {
    override readonly name = 'ThirdPartySdkError';
  }

  test('a foreign throw is reported without inventing a code', async () => {
    const boom = projectable('publishPost', { expose: true }, async () => {
      throw new ThirdPartySdkError('kaboom');
    });
    const result = await runLlmToolCall(
      [boom],
      { id: 'call-4', name: 'publishPost', input: { id: 'p1' } },
      actor,
    );
    expect(result).toEqual({ toolUseId: 'call-4', content: 'tool failed', isError: true });
  });
});

// The values here are the ones the framework did not build: a tool's OUTPUT and a tool's THROW
// both come from an app's own code, and `LlmToolResult.content` is typed `string` — the agent
// loop truncates it, so anything else ends the whole run in a `TypeError` two frames away.
describe('runLlmToolCall survives a result the framework did not build', () => {
  test('a tool that returns nothing answers null, never a content that is not a string', async () => {
    const silent = projectable('publishPost', { expose: true }, async () => undefined);
    const result = await runLlmToolCall(
      [silent],
      { id: 'call-5', name: 'publishPost', input: { id: 'p1' } },
      actor,
    );
    expect(result).toEqual({ toolUseId: 'call-5', content: 'null' });
    expect(typeof result.content).toBe('string');
  });

  // `JSON.stringify` throws on a bigint and on a cycle, and RUNS any `toJSON` the value carries.
  // The tool already ran, so telling the model it failed would buy a second run of its side
  // effects — the result says the call succeeded and the value cannot be read.
  test('an unserialisable result is reported as one, and never as a failed call', async () => {
    for (const output of [
      { total: 10n },
      (() => {
        const cycle: Record<string, unknown> = {};
        cycle['self'] = cycle;
        return cycle;
      })(),
      {
        toJSON() {
          throw new Error('no');
        },
      },
    ]) {
      const odd = projectable('publishPost', { expose: true }, async () => output);
      const result = await runLlmToolCall(
        [odd],
        { id: 'call-6', name: 'publishPost', input: { id: 'p1' } },
        actor,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('not JSON');
      expect(result.content).toContain('ran');
    }
  });

  // The throw a `catch` block cannot read: `typeof error.code` is a getter call, and on a `Proxy`
  // it is a trap. The branch that renders a denial must not be the branch that raises one.
  test('a throw that fights being read is still a tool_result, not a raised TypeError', async () => {
    const hostile: unknown[] = [
      new Proxy(
        {},
        {
          get() {
            throw new Error('trapped get');
          },
          getPrototypeOf() {
            throw new Error('trapped getPrototypeOf');
          },
        },
      ),
      Object.defineProperty(Object.create(null), 'code', {
        get() {
          throw new Error('trapped getter');
        },
        enumerable: true,
      }),
      Symbol('thrown'),
    ];
    for (const value of hostile) {
      const boom = projectable('publishPost', { expose: true }, () => Promise.reject(value));
      const result = await runLlmToolCall(
        [boom],
        { id: 'call-7', name: 'publishPost', input: { id: 'p1' } },
        actor,
      );
      expect(result).toEqual({ toolUseId: 'call-7', content: 'tool failed', isError: true });
    }
  });

  // A null-prototype error object is what a worker, a subprocess or a JSON round trip produces,
  // and it still carries the three fields — reading them must not depend on a prototype.
  test('a null-prototype error object still renders its code, cause and fix', async () => {
    const flattened = Object.assign(Object.create(null), {
      code: 'X_ORDER_LOCKED',
      cause: 'order o-1 is closed',
      fix: 'x db query "select * from orders"',
    });
    const boom = projectable('publishPost', { expose: true }, () => Promise.reject(flattened));
    const result = await runLlmToolCall(
      [boom],
      { id: 'call-8', name: 'publishPost', input: { id: 'p1' } },
      actor,
    );
    expect(result).toEqual({
      toolUseId: 'call-8',
      content: 'X_ORDER_LOCKED: order o-1 is closed (fix: x db query "select * from orders")',
      isError: true,
    });
  });
});

describe('asProjectableAction', () => {
  const publishPost = () =>
    action({
      input: t.object({ id: t.string }),
      output: t.object({ published: t.boolean }),
      policy: allow(),
      mcp: { expose: true, description: 'Publish a draft post' },
      handle: ({ input, ctx }) => ({ published: `${input.id}:${ctx.actor.id}` !== '' }),
    });

  test("a real action() becomes the seam, carrying its own schema and its declaration's name", () => {
    const projected = asProjectableAction(publishPost().named('publishPost'));
    expect(projected.name).toBe('publishPost');
    expect(projected.description).toBe('Publish a draft post');
    expect(projected.mcp?.expose).toBe(true);
    // The action's own `input:`, not the empty stand-in `toLlmTool` falls back to.
    expect(projected.inputJsonSchema).toMatchObject({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    });
  });

  test('run() is invoke: the action parses the model’s arguments and runs as the given actor', async () => {
    const seen: string[] = [];
    const probe = action({
      input: t.object({ id: t.string }),
      output: t.object({ id: t.string }),
      policy: allow(),
      mcp: { expose: true },
      handle: ({ input, ctx }) => {
        seen.push(`${ctx.actor.id}:${JSON.stringify(input)}`);
        return { id: input.id };
      },
    }).named('probe');

    await runWithContext(createContext({}), async () => {
      const result = await runLlmToolCall(
        [asProjectableAction(probe)],
        // The model names an actor and an extra field. Neither survives the action's own parse.
        { id: 'call-9', name: 'probe', input: { id: 'p1', actor: 'admin' } },
        actor,
      );
      expect(result).toEqual({ toolUseId: 'call-9', content: '{"id":"p1"}' });
    });
    expect(seen).toEqual(['agent-1:{"id":"p1"}']);
  });

  test('an unnamed action is refused rather than offered as a tool called ""', () => {
    expect(() => asProjectableAction(publishPost())).toThrow('X_ACTION_UNREGISTERED');
  });

  test('an already-projectable object passes through as itself', () => {
    const fake = projectable('handRolled', { expose: true });
    expect(asProjectableAction(fake)).toBe(fake);
  });

  test('toolLabel names an unregistered action instead of failing to name it', () => {
    expect(toolLabel(publishPost())).toBe('(an unregistered action)');
    expect(toolLabel(publishPost().named('publishPost'))).toBe('publishPost');
    expect(toolLabel(projectable('handRolled'))).toBe('handRolled');
  });
});
