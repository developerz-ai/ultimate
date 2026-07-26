/**
 * contract — the MCP surface is a projection, so the things worth asserting are the projection
 * rules: every exposed action becomes a tool, nothing reaches a client without a policy, and a
 * mutating tool cannot be metered as cheap read chatter by omission.
 *
 * These assert against the real `AppMcp` shape: `tools` is an array, and a tool's policy is
 * enforced inside `handle` rather than exposed as a field — which is why "no tool without a
 * policy" is asserted at construction time (`X_MCP_TOOL_UNSAFE`) instead of by inspecting rows.
 */

import { describeActions } from '@ultimat3/action';
import { defineAppMcp } from '@ultimat3/mcp';
import { t } from '@ultimat3/schema';
import { expect, test } from '@ultimat3/testing';
import { mcp } from './tools';

const bare = (name: string): string => name.replace(/^postly\./, '');

test('every action that declares mcp.expose is a tool, and nothing else is', () => {
  const exposed = describeActions()
    .filter((entry) => entry.mcp?.expose === true)
    .map((entry) => entry.name);
  const toolNames = mcp.tools.map((tool) => bare(tool.name));

  for (const name of exposed) expect(toolNames).toContain(name);

  // The only tools not backed by an action are the three declared in tools.ts. If this list
  // grows, a read tool was added without a matching action — which is fine, but deliberate.
  expect(toolNames.filter((name) => !exposed.includes(name)).sort()).toEqual([
    'digestPreview',
    'planQuote',
    'seatReport',
  ]);
});

test('no tool reaches a client without a policy — it fails at boot, not at call time', () => {
  expect(() =>
    defineAppMcp({
      name: 'postly-test',
      tools: {
        unguarded: {
          description: 'A tool with no policy must not be constructible.',
          input: t.object({}),
          handle: () => Promise.resolve({ ok: true }),
        },
      },
    }),
  ).toThrow(/X_MCP_TOOL_UNSAFE/);
});

test('a read tool is not metered as destructive, and every tool carries a schema', () => {
  const quote = mcp.tools.find((tool) => bare(tool.name) === 'planQuote');
  expect(quote).toBeDefined();
  // planQuote must never charge — see @postly/mcp CLAUDE.md. `destructive` defaults to true,
  // so a read tool has to say so explicitly, and a new mutating tool cannot be cheap by default.
  expect(quote?.destructive).toBe(false);

  for (const tool of mcp.tools) {
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.inputSchema).toBeDefined();
  }
});
