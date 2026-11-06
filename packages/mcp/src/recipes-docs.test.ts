// Recipes from a markdown folder, served verbatim: frontmatter or heading names them, ```call
// fences are their steps and are held to the catalog at boot (a renamed tool refuses, a
// `"<placeholder>"` does not), a dangling `docs://recipes/` link refuses. `docs({ q })` inlines the
// best match and names the nearest on a miss; a caller's own recipes reach that caller alone, on
// `docs` and on `resources/*`; `replayRecipes` calls every fenced example through the server.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no temporary-directory maker and no recursive remove, only per-file writes.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no temp-directory location of its own.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { agentActor, ctxOf, runWithContext } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { defineAppMcp } from './app-tools';
import { resetServedRecipes } from './recipe-links';
import { markdownRecipes, recipeFromMarkdown } from './recipe-markdown';
import { replayRecipes } from './recipe-replay';
import type { McpRecipe } from './recipes';
import type { McpCaller } from './registry';
import type { McpServer } from './server';

afterEach(resetServedRecipes);

const tools = {
  findInvoice: {
    description: 'Find an invoice by number.',
    input: t.object({ number: t.string.min(3) }),
    policy: 'invoice:read',
    destructive: false,
    handle: () => ({ id: 'inv-1' }),
  },
  creditInvoice: {
    description: 'Credit part of an invoice.',
    input: t.object({ amountMinor: t.number }),
    policy: 'invoice:credit',
    handle: () => ({ ok: true }),
  },
} as const;

const REFUND = `---
title: Refund an invoice
description: Find the invoice, then credit it.
---
# ignored heading

Start from the number the customer quotes.

\`\`\`call
findInvoice {"number": "<invoiceNumber>"}
\`\`\`

\`\`\`call
creditInvoice {"amountMinor": "<amount>"}
\`\`\`

Then read docs://recipes/read-an-invoice.
`;

const READ = `# Read an invoice

Look one up by its number.

\`\`\`call
findInvoice {"number": "INV-7"}
\`\`\`
`;

const caller = (id: string): McpCaller => ({
  actor: agentActor({ id, permissions: ['invoice:read', 'invoice:credit'] }),
  scopes: new Set(),
});

const rpc = (server: McpServer, method: string, params: Record<string, unknown>, who: McpCaller) =>
  runWithContext(ctxOf({}), () => server.handle({ jsonrpc: '2.0', id: 1, method, params }, who));

const docs = async (server: McpServer, args: Record<string, unknown>, who = caller('a1')) => {
  const answer = await rpc(server, 'tools/call', { name: 'docs', arguments: args }, who);
  return (answer?.result as { content: { text: string }[] } | undefined)?.content[0]?.text ?? '';
};

const fromFiles = (): McpRecipe[] => [
  recipeFromMarkdown('refund-an-invoice', REFUND),
  recipeFromMarkdown('read-an-invoice', READ),
];

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('markdown recipes', () => {
  test('a folder loads in name order, its frontmatter or heading naming each', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recipes-'));
    try {
      await Bun.write(join(dir, 'refund-an-invoice.md'), REFUND);
      await Bun.write(join(dir, 'read-an-invoice.md'), READ);
      await Bun.write(join(dir, 'notes.txt'), 'not a recipe');
      const loaded = await markdownRecipes({ dir });
      expect(loaded.map((recipe) => [recipe.name, recipe.title, recipe.description])).toEqual([
        ['read-an-invoice', 'Read an invoice', 'Look one up by its number.'],
        ['refund-an-invoice', 'Refund an invoice', 'Find the invoice, then credit it.'],
      ]);
      expect(loaded[1]?.steps.slice(0, 1)).toEqual([
        {
          tool: 'findInvoice',
          why: 'fenced call 1',
          example: { number: '<invoiceNumber>' },
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('the body is served verbatim by resources/read and docs({ uri })', async () => {
    const { server } = defineAppMcp({ tools, recipes: fromFiles() });
    const viaUri = await docs(server, { uri: 'docs://recipes/read-an-invoice' });
    expect(viaUri).toBe(READ);
    const read = await rpc(
      server,
      'resources/read',
      { uri: 'docs://recipes/read-an-invoice' },
      caller('a1'),
    );
    expect(JSON.stringify(read?.result)).toContain(JSON.stringify(READ).slice(1, -1));
  });

  test('a fenced call naming a renamed tool, or a bad argument, fails the boot', () => {
    const renamed = recipeFromMarkdown('x', '```call\nfindInvoices {"number": "INV-7"}\n```\n');
    expect(codeOf(() => defineAppMcp({ tools, recipes: [renamed] }))).toBe(
      'X_MCP_RECIPE_TOOL_UNKNOWN',
    );
    const short = recipeFromMarkdown('y', '```call\nfindInvoice {"number": "I"}\n```\n');
    expect(codeOf(() => defineAppMcp({ tools, recipes: [short] }))).toBe(
      'X_MCP_RECIPE_EXAMPLE_INVALID',
    );
    expect(codeOf(() => recipeFromMarkdown('z', '```call\nfindInvoice {not json}\n```\n'))).toBe(
      'X_MCP_RECIPE_EXAMPLE_INVALID',
    );
  });

  test('a link to a recipe that does not exist fails the boot', () => {
    expect(
      codeOf(() =>
        defineAppMcp({ tools, recipes: [recipeFromMarkdown('refund-an-invoice', REFUND)] }),
      ),
    ).toBe('X_MCP_RECIPE_LINK_DANGLING');
  });
});

describe('docs({ q })', () => {
  test('the best match is inlined; the runner-up is named', async () => {
    const { server } = defineAppMcp({ tools, recipes: fromFiles() });
    const answer = await docs(server, { q: 'refund' });
    expect(answer).toStartWith('# ignored heading');
    expect(answer).toContain('Start from the number');
  });

  test('a miss names the nearest recipes and is never empty', async () => {
    const { server } = defineAppMcp({ tools, recipes: fromFiles() });
    const answer = await docs(server, { q: 'refnud' });
    expect(answer).toContain('No recipe matches "refnud". Nearest:');
    expect(answer.indexOf("docs({ name: 'refund-an-invoice' })")).toBeGreaterThan(-1);
    expect(answer).toContain('refund-an-invoice');
    expect(answer).toContain('read-an-invoice');
    expect(answer.indexOf('refund-an-invoice')).toBeLessThan(answer.indexOf('read-an-invoice'));
  });
});

describe('a caller’s own recipes', () => {
  const own = (who: string): McpRecipe => ({
    name: `tenant-${who}-runbook`,
    title: `Runbook for ${who}`,
    description: 'The tenant’s own steps.',
    steps: [{ tool: 'findInvoice', why: 'look it up' }],
  });
  const extraRecipes = (who: McpCaller) => [own(who.actor?.id ?? 'none')];

  test('listed as source caller, to that caller alone, on docs and resources', async () => {
    const { server } = defineAppMcp({ tools, recipes: fromFiles(), extraRecipes });
    const mine = JSON.parse(await docs(server, {}, caller('a1'))) as {
      recipes: { name: string; source: string }[];
    };
    expect(mine.recipes.find((row) => row.name === 'tenant-a1-runbook')?.source).toBe('caller');
    expect(mine.recipes.find((row) => row.name === 'read-an-invoice')?.source).toBe('app');
    expect(JSON.stringify(mine)).not.toContain('tenant-a2');
    const listed = JSON.stringify(await rpc(server, 'resources/list', {}, caller('a2')));
    expect(listed).toContain('docs://recipes/tenant-a2-runbook');
    expect(listed).not.toContain('tenant-a1');
    const theirs = await rpc(
      server,
      'resources/read',
      { uri: 'docs://recipes/tenant-a1-runbook' },
      caller('a2'),
    );
    expect(theirs?.error).toBeDefined();
    const ownRead = await rpc(
      server,
      'resources/read',
      { uri: 'docs://recipes/tenant-a1-runbook' },
      caller('a1'),
    );
    expect(JSON.stringify(ownRead?.result)).toContain('Runbook for a1');
  });
});

describe('replayRecipes', () => {
  test('every fenced call reaches its tool with placeholders filled, every link lands', async () => {
    const recipes = fromFiles();
    const { server } = defineAppMcp({ tools, recipes });
    const report = await runWithContext(ctxOf({}), () =>
      replayRecipes(server, recipes, {
        caller: caller('a1'),
        placeholders: { invoiceNumber: 'INV-9', amount: 500 },
      }),
    );
    expect(report.calls).toHaveLength(3);
    expect(report.links).toEqual(['docs://recipes/read-an-invoice']);
  });

  test('a placeholder left unfilled is a call the tool refuses, and the replay says so', async () => {
    const recipes = fromFiles();
    const { server } = defineAppMcp({ tools, recipes });
    const failure = await runWithContext(ctxOf({}), () =>
      replayRecipes(server, recipes, {
        caller: caller('a1'),
        placeholders: { invoiceNumber: 'INV-9' },
      }),
    ).then(
      () => expect.unreachable('an argument the tool refuses must fail the replay'),
      (error: unknown) => error as { code: string; message: string },
    );
    expect(failure.code).toBe('X_MCP_RECIPE_EXAMPLE_INVALID');
    expect(failure.message).toContain('refund-an-invoice');
  });
});
