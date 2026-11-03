/**
 * unit — the one list holds the in-app agent: `reviewDraft` is offered `publishPost`, which
 * `@postly/mcp/confirmations` gates (registered by the test preload's boot of `apps/web/api`, as a
 * worker's load of that index does), so a model's call to it publishes nothing until a person says yes.
 */

import { asProjectableAction, describeAgents, runLlmToolCall } from '@ultimat3/ai';
import { expect, test } from '@ultimat3/testing';
import { publishPost } from './publish-post';

test('reviewDraft lists a gated tool, and the model calling it is told to ask a person', async ({
  seed,
  actorFor,
}) => {
  const { draft, bruno } = await seed('dev').pick({
    draft: 'post:draft-money', // Bruno's, so his policy admits the call: only the gate refuses it.
    bruno: 'member:bruno',
  });
  expect(describeAgents().find((one) => one.name === 'reviewDraft')?.tools).toContain(
    'publishPost',
  );

  const answer = await runLlmToolCall(
    [asProjectableAction(publishPost)],
    {
      id: 'call-1',
      name: 'publishPost',
      input: { postId: draft.id, orgId: draft.orgId, notify: false },
    },
    actorFor(bruno),
  );

  expect(answer.isError).toBe(true);
  expect(answer.content).toContain('X_MCP_CONFIRMATION_PENDING');
  expect(answer.content).toContain('ask a person who may approve it');
});
