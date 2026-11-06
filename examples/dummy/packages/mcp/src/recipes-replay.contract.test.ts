/**
 * contract — every recipe Postly serves is followable: `replayRecipes` CALLS each step's example
 * through the real server, as a member who could follow it, and reads every `docs://recipes/` link.
 * A build already refuses a step naming no tool or an example its input rejects; this is the half
 * a build cannot see — a step whose tool refuses the very caller the recipe is written for.
 */

import { agentActor } from '@ultimat3/core';
import { replayRecipes } from '@ultimat3/mcp';
import { expect, test } from '@ultimat3/testing';
import { POSTLY_RECIPES, postlyMcp } from './tools';

interface Member {
  readonly id: string;
  readonly [column: string]: unknown;
}

const agentFor = (member: Member) => ({
  actor: agentActor({
    id: member.id,
    orgId: String(member['orgId']),
    roles: [String(member['role'])],
  }),
  scopes: new Set<string>(),
});

test('an org owner can follow every recipe: each step reaches its tool and is answered', async ({
  seed,
}) => {
  const { ada } = await seed('dev').pick({ ada: 'member:ada' }); // Acme's owner
  const report = await replayRecipes(postlyMcp().server, POSTLY_RECIPES, {
    caller: agentFor(ada),
  });
  expect(report.calls).toEqual([
    'recipe "make-room-for-a-member" step 1 (seatReport)',
    'recipe "make-room-for-a-member" step 2 (planQuote)',
  ]);
});

test('a replay as a member the recipe is not for is refused, naming the step', async ({ seed }) => {
  const { kenji } = await seed('dev').pick({ kenji: 'member:kenji' }); // a reader
  await expect(
    replayRecipes(postlyMcp().server, POSTLY_RECIPES, { caller: agentFor(kenji) }),
  ).rejects.toMatchObject({ code: 'X_MCP_RECIPE_EXAMPLE_INVALID' });
});
