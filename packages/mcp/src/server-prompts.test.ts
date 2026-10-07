// Single responsibility: the two methods `initialize` promised and the dispatch did not answer.
// `ping` is in every MCP client's keep-alive, and `prompts` is an advertised capability whose
// `prompts/list` named prompts that `prompts/get` then refused with `-32601`.

import { describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import type { McpCaller } from './registry';
import { promptFromPath } from './resources';
import { mcpServer } from './server';
import { INVALID_PARAMS } from './wire';

const caller: McpCaller = {
  actor: { kind: 'agent', id: 'agent-1' } as unknown as Actor,
  scopes: new Set(),
};

const call = (method: string, params?: unknown) => ({
  jsonrpc: '2.0',
  id: 7,
  method,
  ...(params === undefined ? {} : { params }),
});

const server = mcpServer({
  prompts: [
    {
      name: 'summarize.v3',
      description: 'Summarize a post',
      arguments: [{ name: 'title', description: 'the post title', required: true }],
      read: (args) => `Summarize the post titled ${args['title'] ?? '?'}.`,
    },
    { name: 'bodiless', description: 'declared with no reader' },
  ],
});

describe('ping', () => {
  test('answers an empty result, never method-not-found', async () => {
    expect(await server.handle(call('ping'), caller)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: {},
    });
  });
});

describe('prompts/get', () => {
  test('resolves a listed prompt to its messages', async () => {
    const response = await server.handle(
      call('prompts/get', { name: 'summarize.v3', arguments: { title: 'Hello' } }),
      caller,
    );
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: {
        description: 'Summarize a post',
        messages: [
          { role: 'user', content: { type: 'text', text: 'Summarize the post titled Hello.' } },
        ],
      },
    });
  });

  test('an unknown name, a missing name and a bodiless prompt are invalid params', async () => {
    for (const params of [{ name: 'nope' }, {}, { name: 'bodiless' }]) {
      const response = await server.handle(call('prompts/get', params), caller);
      expect(response && 'error' in response ? response.error.code : undefined).toBe(
        INVALID_PARAMS,
      );
    }
  });

  test('prompts/list carries no reader — only the wire fields', async () => {
    const response = await server.handle(call('prompts/list'), caller);
    const listed = response && 'result' in response ? response.result : undefined;
    expect(JSON.parse(JSON.stringify(listed))).toEqual(listed);
    expect((listed as { prompts: object[] }).prompts[0]).not.toHaveProperty('read');
  });

  test('a prompt authored as a path reads that file', async () => {
    const path = `${import.meta.dir}/fixtures-prompt-${process.pid}.md`;
    await Bun.write(path, 'Read me.');
    try {
      const fromFile = mcpServer({ prompts: [promptFromPath(path)] });
      const name = promptFromPath(path).name;
      const response = await fromFile.handle(call('prompts/get', { name }), caller);
      const result = response && 'result' in response ? response.result : undefined;
      expect(result).toMatchObject({ messages: [{ content: { text: 'Read me.' } }] });
    } finally {
      await Bun.file(path).delete();
    }
  });
});

describe('prompt visibleTo', () => {
  const staff: McpCaller = { ...caller, role: 'staff' };
  const gated = mcpServer({
    prompts: [
      { name: 'open', description: 'anyone', read: () => 'open' },
      { name: 'staff-only', description: 'staff', visibleTo: ['staff'], read: () => 'secret' },
      {
        name: 'throws',
        description: 'a predicate that throws fails closed',
        visibleTo: () => {
          throw new TypeError('predicate bug');
        },
        read: () => 'never',
      },
    ],
  });
  const names = async (who: McpCaller): Promise<readonly string[]> => {
    const response = await gated.handle(call('prompts/list'), who);
    const result = response && 'result' in response ? response.result : undefined;
    return (result as { prompts: { name: string }[] }).prompts.map((prompt) => prompt.name);
  };

  test('prompts/get refuses a hidden prompt exactly as a missing one — no existence oracle', async () => {
    const hidden = await gated.handle(call('prompts/get', { name: 'staff-only' }), caller);
    const missing = await gated.handle(call('prompts/get', { name: 'nope' }), caller);
    expect(hidden).toMatchObject({ error: { code: INVALID_PARAMS } });
    expect(JSON.stringify(hidden)).not.toContain('secret');
    const message = (response: typeof hidden, name: string) =>
      response && 'error' in response ? response.error?.message.replace(name, '<name>') : '';
    expect(message(hidden, 'staff-only')).toBe(message(missing, 'nope'));
  });

  test('prompts/list omits a prompt the caller may not see, and a throwing predicate', async () => {
    expect(await names(caller)).toEqual(['open']);
    expect(await names(staff)).toEqual(['open', 'staff-only']);
  });

  test('the role the prompt names gets it', async () => {
    const response = await gated.handle(call('prompts/get', { name: 'staff-only' }), staff);
    const result = response && 'result' in response ? response.result : undefined;
    expect(result).toMatchObject({ messages: [{ content: { text: 'secret' } }] });
  });
});
