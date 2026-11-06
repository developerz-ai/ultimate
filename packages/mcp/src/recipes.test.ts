// Recipes that cannot go stale: a step naming a tool that is gone, or an example its tool refuses,
// fails the boot with every offender named; a recipe is served as a resource and through `docs`,
// deterministic markdown, and hidden from a caller who cannot call one of its tools.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  agentActor,
  ctxOf,
  registerErrorCodes,
  runWithContext,
  UltimateError,
} from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { defineAppMcp } from './app-tools';
import { asFrameworkError } from './framework-error';
import { assertRecipeLinks, resetServedRecipes, servedRecipes } from './recipe-links';
import type { McpRecipe } from './recipes';
import { renderRecipe } from './recipes';
import type { McpCaller } from './registry';
import type { McpServer } from './server';

afterEach(resetServedRecipes);

const tools = {
  findInvoice: {
    description: 'Find an invoice by number.',
    input: t.object({ number: t.string }),
    policy: 'invoice:read',
    destructive: false,
    handle: () => ({ id: 'inv-1' }),
  },
  issueCreditNote: {
    description: 'Issue a credit note against an invoice.',
    input: t.object({ invoiceId: t.string, amountMinor: t.number }),
    policy: 'invoice:credit',
    visibleTo: ['staff'],
    handle: () => ({ ok: true }),
  },
} as const;

const creditNote: McpRecipe = {
  name: 'issue-a-credit-note',
  title: 'Issue a credit note',
  description: 'Refund part of an invoice without touching the payment.',
  steps: [
    { tool: 'findInvoice', why: 'get the invoice id', example: { number: 'INV-7' } },
    {
      tool: 'issueCreditNote',
      why: 'credit it',
      example: { invoiceId: 'inv-1', amountMinor: 500 },
    },
  ],
  notes: 'Credit notes are final.',
};

const staff: McpCaller = {
  actor: agentActor({ id: 'a1', roles: ['staff'] }),
  role: 'staff',
  scopes: new Set(),
};
const customer: McpCaller = {
  actor: agentActor({ id: 'a2' }),
  role: 'customer',
  scopes: new Set(),
};

const rpc = (
  server: McpServer,
  method: string,
  params: Record<string, unknown>,
  caller: McpCaller,
) =>
  runWithContext(ctxOf({}), () => server.handle({ jsonrpc: '2.0', id: 1, method, params }, caller));

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof UltimateError ? `${error.code} ${error.cause}` : 'not coded';
  }
  return undefined;
};

describe('recipes: the boot checks', () => {
  test('a renamed tool refuses the boot, naming the recipe and the tool', () => {
    const stale = { ...creditNote, steps: [{ tool: 'findInvoiceByNumber', why: 'x' }] };
    const refused = codeOf(() => defineAppMcp({ tools, recipes: [stale] }));
    expect(refused).toStartWith('X_MCP_RECIPE_TOOL_UNKNOWN');
    expect(refused).toContain('issue-a-credit-note');
    expect(refused).toContain('findInvoiceByNumber');
  });

  test('a stale example is refused, every offender in one boot', () => {
    const stale: McpRecipe = {
      ...creditNote,
      steps: [
        { tool: 'findInvoice', why: 'x', example: { num: 'INV-7' } },
        { tool: 'issueCreditNote', why: 'y', example: { invoiceId: 'inv-1', amountMinor: 'five' } },
      ],
    };
    const refused = codeOf(() => defineAppMcp({ tools, recipes: [stale] }));
    expect(refused).toStartWith('X_MCP_RECIPE_EXAMPLE_INVALID');
    expect(refused).toContain('step 1');
    expect(refused).toContain('step 2');
  });

  test('docs://recipes/ belongs to recipes:, and a name is taken once', () => {
    const hand = {
      uri: 'docs://recipes/x',
      name: 'x',
      description: 'x',
      mimeType: 'text/markdown',
      read: () => '',
    };
    expect(
      codeOf(() => defineAppMcp({ tools, recipes: [creditNote], resources: [hand] })),
    ).toStartWith('X_MCP_RECIPE_URI_RESERVED');
    expect(codeOf(() => defineAppMcp({ tools, recipes: [creditNote, creditNote] }))).toStartWith(
      'X_MCP_RECIPE_URI_RESERVED',
    );
    // Without recipes: the hand-written resource is unjudged until the next major.
    expect(codeOf(() => defineAppMcp({ tools, resources: [hand] }))).toBeUndefined();
  });

  test('an app tool already named docs collides with the recipes tool', () => {
    const docs = { ...tools.findInvoice };
    expect(
      codeOf(() => defineAppMcp({ tools: { ...tools, docs }, recipes: [creditNote] })),
    ).toStartWith('X_MCP_TOOL_DUPLICATE');
  });
});

describe('recipes: served', () => {
  test('the body is deterministic markdown from the structure', () => {
    expect(renderRecipe(creditNote)).toBe(renderRecipe({ ...creditNote }));
    expect(renderRecipe(creditNote)).toContain('1. `findInvoice` — get the invoice id');
    expect(renderRecipe(creditNote)).toContain('{"number":"INV-7"}');
  });

  test('resources/read and docs({ name }) answer the same body', async () => {
    const { server } = defineAppMcp({ tools, recipes: [creditNote] });
    const read = await rpc(
      server,
      'resources/read',
      { uri: 'docs://recipes/issue-a-credit-note' },
      staff,
    );
    const contents = (
      read?.result as { contents: { text: string; mimeType: string }[] } | undefined
    )?.contents[0];
    expect(contents?.mimeType).toBe('text/markdown');
    const viaTool = await rpc(
      server,
      'tools/call',
      { name: 'docs', arguments: { name: 'issue-a-credit-note' } },
      staff,
    );
    expect((viaTool?.result as { content: { text: string }[] } | undefined)?.content[0]?.text).toBe(
      contents?.text ?? '',
    );
  });

  test('a caller who cannot see one step’s tool gets not-found, byte-equal to an unknown name', async () => {
    const { server } = defineAppMcp({ tools, recipes: [creditNote] });
    const hidden = await rpc(
      server,
      'resources/read',
      { uri: 'docs://recipes/issue-a-credit-note' },
      customer,
    );
    const unknown = await rpc(server, 'resources/read', { uri: 'docs://recipes/nope' }, customer);
    expect(JSON.stringify(hidden?.error).replace('issue-a-credit-note', 'X')).toBe(
      JSON.stringify(unknown?.error).replace('nope', 'X'),
    );
    const listed = await rpc(server, 'tools/call', { name: 'docs', arguments: {} }, customer);
    expect((listed?.result as { content: { text: string }[] } | undefined)?.content[0]?.text).toBe(
      '{"recipes":[]}',
    );
    const resources = await rpc(server, 'resources/list', {}, customer);
    expect(JSON.stringify(resources?.result)).not.toContain('docs://recipes/');
    const byTool = (name: string) =>
      rpc(server, 'tools/call', { name: 'docs', arguments: { name } }, customer);
    const a = JSON.stringify((await byTool('issue-a-credit-note'))?.result).replace(
      'issue-a-credit-note',
      'X',
    );
    const b = JSON.stringify((await byTool('nope'))?.result).replace('nope', 'X');
    expect(a).toBe(b);
  });
});

describe('recipes: scopes', () => {
  test('a token missing one step’s scope does not list the recipe', async () => {
    const { server } = defineAppMcp({
      tools,
      recipes: [creditNote],
      scopes: { 'invoice:read': ['findInvoice'], 'invoice:credit': ['issueCreditNote'] },
    });
    const list = async (scopes: readonly string[]) =>
      (
        (
          await rpc(
            server,
            'tools/call',
            { name: 'docs', arguments: {} },
            { ...staff, scopes: new Set(scopes) },
          )
        )?.result as { content: { text: string }[] } | undefined
      )?.content[0]?.text;
    expect(await list(['invoice:read'])).toBe('{"recipes":[]}');
    expect(await list(['invoice:read', 'invoice:credit'])).toContain('issue-a-credit-note');
  });
});

describe('recipes: an error that links to one', () => {
  test('a declared link no endpoint serves is X_MCP_RECIPE_UNKNOWN at load', () => {
    defineAppMcp({ tools, recipes: [creditNote] });
    expect(() => assertRecipeLinks(servedRecipes())).not.toThrow();
    registerErrorCodes({
      X_TEST_CREDIT_LINK: { title: 'linked', docs: 'docs://recipes/issue-a-credit-note' },
    });
    // Served by the first endpoint: a second endpoint without it does not break the link.
    defineAppMcp({ tools: { findInvoice: tools.findInvoice }, recipes: [] });
    expect(() => assertRecipeLinks(servedRecipes())).not.toThrow();
    expect(() => assertRecipeLinks(new Set(['other']))).toThrow(
      expect.objectContaining({ code: 'X_MCP_RECIPE_UNKNOWN' }),
    );
  });

  test('a throw-site link to no recipe is dropped at render once recipes exist', () => {
    const linked = (docs: string) =>
      new UltimateError({ code: 'X_MCP_TOOL_UNKNOWN', cause: 'c', fix: 'x help', docs });
    expect(asFrameworkError(linked('docs://recipes/gone'))?.docs).toBe('docs://recipes/gone');
    defineAppMcp({ tools, recipes: [creditNote] });
    expect(asFrameworkError(linked('docs://recipes/gone'))?.docs).toBeUndefined();
    expect(asFrameworkError(linked('docs://recipes/issue-a-credit-note'))?.docs).toBe(
      'docs://recipes/issue-a-credit-note',
    );
  });
});
