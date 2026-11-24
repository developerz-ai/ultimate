// Recipes in sections: `<section>/<name>.md` is `docs://<section>/<name>` on the tool and on
// `resources/read`; `docs({})` can answer a text map grouped by section; `aliases:` score in
// search; a caller's own section reaches that caller alone; a section is a closed name.

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
import type { DocsToolOptions, ExtraRecipes } from './recipes-tool';
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
} as const;

const READ = `# Read an invoice

Look one up by its number.

\`\`\`call
findInvoice {"number": "INV-7"}
\`\`\`

The codes it can answer: docs://ref/error-codes.
`;

const CODES = `---
title: Error codes
aliases: refusals, [ignored]
---
Every code this server answers, and what each means.
`;

const REFUND = `---
title: Give money back
aliases: [reimburse, "credit note"]
---
Find the invoice first: docs://recipes/read-an-invoice.
`;

const caller = (id: string): McpCaller => ({
  actor: agentActor({ id, permissions: ['invoice:read'] }),
  scopes: new Set(),
});

const rpc = (server: McpServer, method: string, params: Record<string, unknown>, who: McpCaller) =>
  runWithContext(ctxOf({}), () => server.handle({ jsonrpc: '2.0', id: 1, method, params }, who));

const docs = async (server: McpServer, args: Record<string, unknown>, who = caller('a1')) =>
  JSON.stringify(await rpc(server, 'tools/call', { name: 'docs', arguments: args }, who));

const docsText = async (server: McpServer, args: Record<string, unknown>, who = caller('a1')) => {
  const answer = await rpc(server, 'tools/call', { name: 'docs', arguments: args }, who);
  return (answer?.result as { content: { text: string }[] } | undefined)?.content[0]?.text ?? '';
};

const readText = async (server: McpServer, uri: string, who = caller('a1')) => {
  const answer = await rpc(server, 'resources/read', { uri }, who);
  return (answer?.result as { contents: { text: string }[] } | undefined)?.contents[0]?.text;
};

const serve = (
  recipes: readonly McpRecipe[],
  more: { extraRecipes?: ExtraRecipes; docsTool?: DocsToolOptions } = {},
): McpServer => defineAppMcp({ tools, recipes, ...more }).server;

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

async function withFolder<T>(
  files: Record<string, string>,
  run: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'recipe-sections-'));
  try {
    for (const [path, text] of Object.entries(files)) await Bun.write(join(dir, path), text);
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('recipes: sections from a folder', () => {
  test('a two-section folder resolves both URIs on the tool and on resources/read', async () => {
    await withFolder(
      {
        'read-an-invoice.md': READ,
        'ref/error-codes.md': CODES,
        'recipes/refund-an-invoice.md': REFUND,
      },
      async (dir) => {
        const recipes = await markdownRecipes({ dir });
        expect(recipes.map((recipe) => [recipe.section, recipe.name])).toEqual([
          [undefined, 'read-an-invoice'],
          ['recipes', 'refund-an-invoice'],
          ['ref', 'error-codes'],
        ]);
        const server = serve(recipes);
        for (const [uri, body] of [
          ['docs://recipes/read-an-invoice', READ],
          ['docs://recipes/refund-an-invoice', REFUND.slice(REFUND.indexOf('Find'))],
          ['docs://ref/error-codes', CODES.slice(CODES.indexOf('Every'))],
        ] as const) {
          expect(await readText(server, uri)).toBe(body);
          expect(await docsText(server, { uri })).toBe(body);
        }
        expect(await docsText(server, { name: 'ref/error-codes' })).toBe(
          await docsText(server, { uri: 'docs://ref/error-codes' }),
        );
        expect(await docsText(server, { name: 'refund-an-invoice' })).toContain('Find the invoice');
        const replayed = await runWithContext(ctxOf({}), () =>
          replayRecipes(server, recipes, { caller: caller('a1') }),
        );
        expect(replayed.links).toEqual([
          'docs://ref/error-codes',
          'docs://recipes/read-an-invoice',
        ]);
      },
    );
  });

  test('docs({}) with index: map is plain text grouped by section', async () => {
    await withFolder({ 'read-an-invoice.md': READ, 'ref/error-codes.md': CODES }, async (dir) => {
      const server = serve(await markdownRecipes({ dir }), { docsTool: { index: 'map' } });
      expect(await docsText(server, {})).toBe(
        '# recipes\ndocs://recipes/read-an-invoice  Read an invoice\n\n# ref\ndocs://ref/error-codes  Error codes\n',
      );
    });
  });

  test('the app may supply the docs tool description', async () => {
    const server = serve(
      [recipeFromMarkdown('read-an-invoice', READ.split('The codes')[0] ?? '')],
      {
        docsTool: { description: 'Docs for this server. docs({}) lists them.' },
      },
    );
    const listed = await rpc(server, 'tools/list', {}, caller('a1'));
    const tool = (
      listed?.result as { tools: { name: string; description: string }[] } | undefined
    )?.tools.find((entry) => entry.name === 'docs');
    expect(tool?.description).toBe('Docs for this server. docs({}) lists them.');
  });

  test('a one-folder app answers the same bytes as before sections existed', async () => {
    const recipe = recipeFromMarkdown('read-an-invoice', READ.split('The codes')[0] ?? '');
    expect(recipe.section).toBeUndefined();
    const server = serve([recipe]);
    expect(await docsText(server, {})).toBe(
      JSON.stringify({
        recipes: [
          {
            name: 'read-an-invoice',
            title: 'Read an invoice',
            description: 'Look one up by its number.',
            uri: 'docs://recipes/read-an-invoice',
            source: 'app',
          },
        ],
      }),
    );
    expect(await docsText(server, { uri: 'docs://recipes/read-an-invoice' })).toBe(
      await docsText(server, { name: 'read-an-invoice' }),
    );
  });
});

describe('recipes: aliases', () => {
  test('a search that hits only an alias returns that doc first', async () => {
    const recipes = [
      recipeFromMarkdown('read-an-invoice', READ),
      recipeFromMarkdown('error-codes', CODES, 'ref'),
      recipeFromMarkdown('refund-an-invoice', REFUND),
    ];
    expect(recipes[2]?.aliases).toEqual(['reimburse', 'credit note']);
    expect(recipes[1]?.aliases).toEqual(['refusals', '[ignored]']);
    const server = serve(recipes);
    const answer = await docsText(server, { q: 'how do I reimburse a customer' });
    expect(answer.startsWith('Find the invoice first')).toBe(true);
    expect(await docsText(server, { q: 'refusals' })).toStartWith('Every code');
  });
});

describe('recipes: a caller’s own section', () => {
  const mine: McpRecipe = {
    name: 'my-runbook',
    section: 'notes',
    title: 'My runbook',
    description: 'Only for a1.',
    steps: [],
  };
  const extraRecipes: ExtraRecipes = (who) => (who.actor.id === 'a1' ? [mine] : []);

  test('reaches that caller, and reads to another exactly as a miss', async () => {
    const server = serve(
      [recipeFromMarkdown('read-an-invoice', READ.split('The codes')[0] ?? '')],
      {
        extraRecipes,
        docsTool: { index: 'map' },
      },
    );
    expect(await docsText(server, {})).toContain(
      '# notes\ndocs://notes/my-runbook  My runbook (yours)',
    );
    expect(await readText(server, 'docs://notes/my-runbook')).toContain('# My runbook');
    const other = caller('a2');
    expect(await docsText(server, {}, other)).not.toContain('notes');
    const bare = serve([recipeFromMarkdown('read-an-invoice', READ.split('The codes')[0] ?? '')], {
      docsTool: { index: 'map' },
    });
    for (const args of [{ uri: 'docs://notes/my-runbook' }, { name: 'notes/my-runbook' }]) {
      expect(await docs(server, args, other)).toBe(await docs(bare, args, other));
    }
    const read = { uri: 'docs://notes/my-runbook' };
    expect(JSON.stringify(await rpc(server, 'resources/read', read, other))).toBe(
      JSON.stringify(await rpc(bare, 'resources/read', read, other)),
    );
  });

  test('a caller’s section outside the closed pattern is refused, never served', async () => {
    const server = serve([], {
      extraRecipes: () => [{ ...mine, section: '..' }],
    });
    expect(await docs(server, {})).toContain('X_MCP_RECIPE_URI_RESERVED');
  });
});

describe('recipes: a section is a closed name', () => {
  const plain = recipeFromMarkdown('error-codes', CODES);

  test('a section that tries to step out of docs:// refuses the boot', () => {
    for (const section of ['..', 'a/b', 'Ref', '']) {
      expect(codeOf(() => serve([{ ...plain, section }]))).toBe('X_MCP_RECIPE_URI_RESERVED');
    }
  });

  test('a folder outside the pattern loads, then refuses the boot', async () => {
    await withFolder({ 'Bad Folder/error-codes.md': CODES }, async (dir) => {
      const recipes = await markdownRecipes({ dir });
      expect(recipes[0]?.section).toBe('Bad Folder');
      expect(codeOf(() => serve(recipes))).toBe('X_MCP_RECIPE_URI_RESERVED');
    });
  });

  test('one name in two sections is two recipes; one URI twice is a duplicate', () => {
    expect(codeOf(() => serve([plain, { ...plain, section: 'ref' }]))).toBeUndefined();
    expect(
      codeOf(() =>
        serve([
          { ...plain, section: 'ref' },
          { ...plain, section: 'ref' },
        ]),
      ),
    ).toBe('X_MCP_RECIPE_URI_RESERVED');
  });

  test('a section recipes use is theirs: a hand-written resource under it refuses', () => {
    const resource = {
      uri: 'docs://ref/by-hand',
      name: 'By hand',
      description: 'Written by hand.',
      mimeType: 'text/markdown',
      read: () => 'x',
    };
    const boot = (section: string) => () =>
      defineAppMcp({ tools, recipes: [{ ...plain, section }], resources: [resource] });
    expect(codeOf(boot('ref'))).toBe('X_MCP_RECIPE_URI_RESERVED');
    expect(codeOf(boot('guides'))).toBeUndefined();
  });

  test('a link into a served section must resolve; another docs:// prefix is not judged', () => {
    const linking = (text: string) => recipeFromMarkdown('linking', `# Linking\n\n${text}\n`);
    const ref = { ...plain, section: 'ref' };
    expect(codeOf(() => serve([ref, linking('See docs://ref/nope.')]))).toBe(
      'X_MCP_RECIPE_LINK_DANGLING',
    );
    expect(codeOf(() => serve([ref, linking('See docs://ref/error-codes.')]))).toBeUndefined();
    expect(codeOf(() => serve([ref, linking('See docs://elsewhere/x.')]))).toBeUndefined();
  });
});
