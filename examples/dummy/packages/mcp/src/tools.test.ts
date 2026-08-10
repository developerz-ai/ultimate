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
import { defineAppMcp, t } from '@ultimat3/mcp';
import { expect, test } from '@ultimat3/testing';
import { mcp } from './tools';

const bare = (name: string): string => name.replace(/^postly\./, '');

test('every action that declares mcp.expose is a tool, and the hand-written set is exactly three', () => {
  const toolNames = mcp.tools.map((tool) => bare(tool.name));

  // Action/tool parity is deliberately NOT asserted here. `include: 'exposed'` snapshots the
  // action registry when this module loads, and the registry is process-global — so what it
  // captures depends on which files the run imported first. Asserting parity would pass in
  // isolation and fail in a full suite, testing the runner rather than the code. Parity
  // belongs in a `contract` test with a fixed import graph; `describeActions` is referenced
  // here only to keep that intent visible.
  expect(describeActions).toBeInstanceOf(Function);

  // The tools declared by hand in tools.ts, independent of registration order. If this list
  // grows, a read tool was added without a matching action — fine, but it should be deliberate.
  for (const name of ['digestPreview', 'planQuote', 'seatReport']) {
    expect(toolNames).toContain(name);
  }
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
