import { describe, expect, test } from 'bun:test';
import { agentActor } from '@ultimat3/core';
import { forbidden } from '@ultimat3/policy';
import type { ProjectableAction } from './tools';
import { runLlmToolCall, toLlmTool, toLlmTools } from './tools';

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
