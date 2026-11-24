// A recipe URI means exactly what it spells: a link is checked whole, a `docs({ uri })` argument
// is matched as written, a map line is one line, and replay reads links into every served section.

import { afterEach, describe, expect, test } from 'bun:test';
import { agentActor, ctxOf, runWithContext } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { defineAppMcp } from './app-tools';
import { McpRecipeUriReservedError } from './recipe-errors';
import { resetServedRecipes } from './recipe-links';
import { recipeFromMarkdown } from './recipe-markdown';
import { replayRecipes } from './recipe-replay';
import type { McpRecipe } from './recipes';
import type { DocsToolOptions } from './recipes-tool';
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

const caller = (id: string, permissions: readonly string[] = ['invoice:read']): McpCaller => ({
  actor: agentActor({ id, permissions: [...permissions] }),
  scopes: new Set(),
});

const serve = (recipes: readonly McpRecipe[], docsTool?: DocsToolOptions): McpServer =>
  defineAppMcp({ tools, recipes, ...(docsTool === undefined ? {} : { docsTool }) }).server;

const docsText = async (server: McpServer, args: Record<string, unknown>) => {
  const answer = await runWithContext(ctxOf({}), () =>
    server.handle(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'docs', arguments: args } },
      caller('a1'),
    ),
  );
  return (answer?.result as { content: { text: string }[] } | undefined)?.content[0]?.text ?? '';
};

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const errors = recipeFromMarkdown('errors', '# Errors\n\nEvery code.\n', 'ref');
const linking = (text: string): McpRecipe =>
  recipeFromMarkdown('linking', `# Linking\n\n${text}\n`);

describe('a recipe link is checked whole', () => {
  test('extra path segments past a served recipe are a dangling link', () => {
    expect(codeOf(() => serve([errors, linking('See docs://ref/errors/old.')]))).toBe(
      'X_MCP_RECIPE_LINK_DANGLING',
    );
    expect(() => serve([errors, linking('See docs://ref/errors, then act.')])).not.toThrow();
  });

  test('a dotted suffix is part of the link; a sentence’s full stop is not', () => {
    for (const text of [
      '[Errors](docs://ref/errors.html)',
      'See docs://ref/errors.json.',
      '[Errors](docs://ref/errors%20old)',
    ]) {
      expect(codeOf(() => serve([errors, linking(text)]))).toBe('X_MCP_RECIPE_LINK_DANGLING');
    }
    expect(() => serve([errors, linking('[Errors](docs://ref/errors). Then act.')])).not.toThrow();
  });

  test('the dangling refusal names the section it was linked into', () => {
    let cause = '';
    try {
      serve([errors, linking('See docs://ref/nope.')]);
    } catch (error) {
      cause = (error as { cause?: unknown }).cause as string;
    }
    expect(cause).toContain('docs://ref/nope');
    expect(cause).not.toContain('docs://recipes/ URI');
  });
});

describe('docs({ uri }) matches the URI as written', () => {
  test('docs://recipes/<section>/<name> is not another section’s recipe', async () => {
    const server = serve([errors]);
    expect(await docsText(server, { uri: 'docs://ref/errors' })).toStartWith('# Errors');
    expect(await docsText(server, { uri: 'docs://recipes/ref/errors' })).toContain(
      'X_MCP_TOOL_UNKNOWN',
    );
  });

  test('the argument schema names any section’s URI', async () => {
    const listed = await runWithContext(ctxOf({}), () =>
      serve([errors]).handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, caller('a1')),
    );
    const docs = (
      listed?.result as
        | { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] }
        | undefined
    )?.tools.find((tool) => tool.name === 'docs');
    const uri = docs?.inputSchema.properties['uri'] as { description: string };
    expect(uri.description).not.toContain('docs://recipes/');
    expect(uri.description).toContain('docs://<section>/<name>');
  });
});

describe('a title on one line', () => {
  const multi: McpRecipe = { ...errors, title: 'Errors\nand\r\nrefusals' };
  const separated: McpRecipe = { ...errors, title: 'Errors\u2028and\u2029refusals' };

  test('in the text map', async () => {
    for (const recipe of [multi, separated]) {
      expect(await docsText(serve([recipe], { index: 'map' }), {})).toBe(
        '# ref\ndocs://ref/errors  Errors and refusals\n',
      );
    }
  });

  test('in a search miss’s nearest names', async () => {
    expect(await docsText(serve([multi]), { q: 'zzzz' })).toBe(
      'No recipe matches "zzzz". Nearest:\n- docs({ name: \'ref/errors\' }) — Errors and refusals\n',
    );
  });

  // Each whitespace run is matched once (no backtracking from every position); output pinned here.
  test('a long run of spaces keeps its spaces', async () => {
    const wide: McpRecipe = { ...errors, title: `a${' '.repeat(50_000)}b` };
    const map = await docsText(serve([wide], { index: 'map' }), {});
    expect(map).toBe(`# ref\ndocs://ref/errors  ${wide.title}\n`);
  });
});

describe('replayRecipes: links', () => {
  test('a subset replay reads links into every section the server serves', async () => {
    const link = linking('See docs://ref/errors.');
    const server = serve([errors, link]);
    const replayed = await runWithContext(ctxOf({}), () =>
      replayRecipes(server, [link], { caller: caller('a1'), sections: ['ref'] }),
    );
    expect(replayed.links).toEqual(['docs://ref/errors']);
  });

  test('a sectioned link the caller cannot read is dangling', async () => {
    const hidden = recipeFromMarkdown(
      'hidden',
      '# Hidden\n\n```call\nfindInvoice {"number": "INV-7"}\n```\n',
      'ref',
    );
    const link = linking('See docs://ref/hidden.');
    // `findInvoice` needs a scope this caller's token lacks: the recipe naming it reads as absent.
    const server = defineAppMcp({
      tools,
      recipes: [hidden, link],
      scopes: { 'invoice:read': ['findInvoice'] },
    }).server;
    let refused: { code?: string; cause?: unknown } = {};
    try {
      await runWithContext(ctxOf({}), () =>
        replayRecipes(server, [link], { caller: caller('a1'), sections: ['ref'] }),
      );
    } catch (error) {
      refused = error as { code?: string; cause?: unknown };
    }
    expect(refused.code).toBe('X_MCP_RECIPE_LINK_DANGLING');
    // The recipe exists: the refusal says this caller could not read it, not that none serves it.
    expect(String(refused.cause)).toContain('could not read');
    // Its fix keeps the replay's other options: dropping `sections` would skip this very link.
    expect((refused as { fix?: string }).fix).toContain('...options');
  });
});

describe('the reserved-URI fix', () => {
  test('its object literal parses', () => {
    const fix = new McpRecipeUriReservedError({ uri: 'docs://x/Y', reason: 'name' }).fix ?? '';
    const literal = fix.split('#')[0] ?? '';
    expect(literal).toStartWith('recipes: [{');
    expect(() =>
      new Bun.Transpiler({ loader: 'ts' }).transformSync(`({ ${literal} });`),
    ).not.toThrow();
  });
});
