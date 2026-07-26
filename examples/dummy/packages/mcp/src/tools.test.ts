/**
 * contract — the MCP surface is a projection, so the things worth asserting are the projection
 * rules: every exposed action is a tool, every tool has a policy, and the policy is the *same
 * object* the HTTP path uses rather than an equivalent-looking copy.
 */

import { expect, test } from '@ultimat3/testing';
import { mcp } from './tools';

test('every action that declares mcp.expose is a tool, and nothing else is', async ({
  manifest,
}) => {
  const exposed = manifest.actions.filter((entry) => entry.mcp?.expose).map((entry) => entry.name);
  const toolNames = mcp.tools().map((tool) => tool.name.replace('postly.', ''));

  for (const name of exposed) expect(toolNames).toContain(name);
  // The only tools not backed by an action are the three declared in tools.ts.
  expect(toolNames.filter((name) => !exposed.includes(name)).sort()).toEqual([
    'digestPreview',
    'planQuote',
    'seatReport',
  ]);
});

test('no tool reaches a client without a policy', () => {
  const unguarded = mcp.tools().filter((tool) => tool.policy === undefined);
  expect(unguarded.map((tool) => tool.name)).toEqual([]);
});

test('a tool and its HTTP route share one policy object, not two equal ones', async ({
  actionByName,
}) => {
  const tool = mcp.tool('postly.publishPost');
  expect(tool.policy).toBe(actionByName('publishPost').policy);
});

test('planQuote quotes without charging', async ({ seed, actorFor, billing }) => {
  const { owner } = await seed('dev').pick({ owner: 'member:ada' });

  const quote = await mcp.call('postly.planQuote', { plan: 'business' }, actorFor(owner));

  expect(quote.charge.currency).toBe('USD');
  expect(quote.charge.minor).toBeGreaterThan(0);
  expect(billing.charges()).toEqual([]); // the money tool is upgradePlan, and it was not called
});

test('a tool denies exactly where the UI would', async ({ seed, actorFor }) => {
  const { author } = await seed('dev').pick({ author: 'member:bruno' }); // not an owner

  await expect(mcp.call('postly.seatReport', {}, actorFor(author))).rejects.toMatchError(
    'X_POLICY_DENIED',
  );
});
