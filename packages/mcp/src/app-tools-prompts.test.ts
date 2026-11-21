// `defineAppMcp`'s `prompts` authoring form: a markdown path becomes a named prompt, an object
// passes through. A file of its own so it runs beside `app-tools.test.ts` without pushing it over
// the ceiling.

import { describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { agentActor } from '@ultimat3/core';
import { defineAppMcp } from './app-tools';
import type { McpCaller } from './registry';

const owner = agentActor({ id: 'a1', orgId: 'o1', roles: ['owner'] });

const caller = (actor: Actor): McpCaller => ({ actor, scopes: new Set<string>() });

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

  // What `prompts/get` ACTUALLY passes its reader: every string argument, declared or not, and
  // nothing that is not a string (`prompts-get.ts`'s `stringArguments`). The reader shape is
  // `Record<string, string>`, not the `arguments` list, so a prompt must not claim a rejection the
  // dispatcher never performs — it filters, it does not refuse.
  test('prompts/get hands the reader every string argument and drops the rest', async () => {
    const seen: (Readonly<Record<string, string>> | undefined)[] = [];
    const mcp = defineAppMcp({
      prompts: [
        {
          name: 'triage',
          description: 'Triage a comment thread.',
          arguments: [{ name: 'threadId', description: 'The thread to triage.', required: true }],
          read: (args) => {
            seen.push(args);
            return 'triaged';
          },
        },
      ],
    });

    const response = await mcp.server.handle(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'prompts/get',
        // A declared string, an undeclared string, and two non-strings: the strays are accepted and
        // filtered, never refused — the argument list is documentation, not enforcement.
        params: {
          name: 'triage',
          arguments: { threadId: 't1', stamp: 'now', limit: 5, deep: true },
        },
      },
      caller(owner),
    );

    expect(seen).toEqual([{ threadId: 't1', stamp: 'now' }]);
    expect((response?.result as { messages: { content: { text: string } }[] }).messages).toEqual([
      { role: 'user', content: { type: 'text', text: 'triaged' } },
    ]);
  });
});
