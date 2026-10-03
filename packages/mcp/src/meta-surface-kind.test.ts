// The meta catalog's `kind` reads `destructive` the way the rate limiter does
// (`ToolRegistry.verbClass`): only `true` is a write. A hand-registered tool that omits it was
// metered as a read and listed as an action — one tool, two answers to one question.

import { describe, expect, test } from 'bun:test';
import { agentActor } from '@ultimat3/core';
import type { AnyMcpTool, McpCaller } from './registry';
import { textResult } from './registry';
import { createMcpServer } from './server';
import { NO_ARGS } from './wire';

const tool = (name: string, destructive: boolean | undefined): AnyMcpTool => ({
  name,
  description: name,
  inputSchema: NO_ARGS,
  ...(destructive === undefined ? {} : { destructive }),
  handle: async () => textResult('ok'),
});

const caller: McpCaller = { actor: agentActor({ id: 'a1' }), scopes: new Set<string>() };

describe('the meta catalog kind', () => {
  test('agrees with the metering class for true, false and an omitted destructive', () => {
    const tools = [tool('omitted', undefined), tool('reads', false), tool('writes', true)];
    const server = createMcpServer({
      tools,
      surface: 'meta',
      groups: { things: { description: 'Things', tools: tools.map((t) => t.name) } },
    });
    const actions = server.catalog(caller)?.[0]?.actions ?? [];
    for (const name of ['omitted', 'reads', 'writes']) {
      const kind = actions.find((action) => action.name === name)?.kind;
      expect(kind).toBe(server.tools.verbClass(name) === 'write' ? 'action' : 'query');
    }
    expect(actions.find((action) => action.name === 'omitted')?.kind).toBe('query');
  });
});
