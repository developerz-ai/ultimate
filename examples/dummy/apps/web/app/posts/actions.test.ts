/**
 * unit — `requestPostsExport`, and the posts feature's model-backed actions, `summarizePosts` (a `hive()`) and `reviewDraft`
 * (an `agent()`), against a deterministic provider installed as the app's AI runtime. What is
 * asserted is the factory's contract as this app relies on it: members in the order asked, one
 * unreadable post failing alone, the agent's answer parsed into its schema, and a refusal decided
 * before a single token is spent.
 */

import { configureAi, createGateway, EchoProvider } from '@ultimat3/ai';
import { beforeEach, expect, test } from '@ultimat3/testing';
import { requestPostsExport, reviewDraft, summarizePosts } from './actions';
import { exportPosts, postsExportPrefix } from './jobs';

/** Every prompt the provider was sent, so a refusal can be shown to have cost nothing. */
const sent: string[] = [];

/** The reviewer and the summariser answer differently; both answer in their declared schema. */
const answer = (prompt: string): string => {
  sent.push(prompt);
  return prompt.includes('editor of a team blog')
    ? JSON.stringify({ verdict: 'revise', notes: 'Say which rounding rule the body defends.' })
    : JSON.stringify({ summary: 'Minor units and a currency.', tags: ['money'] });
};

// Installed fresh per test: `configureAi` replaces the runtime and clears the semantic cache, so no
// test answers from a summary another one cached.
beforeEach(() => {
  sent.length = 0;
  configureAi({ gateway: createGateway({ providers: [new EchoProvider({ fallback: answer })] }) });
});

test('summarizePosts answers one member per post, in the order asked, and a foreign post fails alone', async ({
  seed,
  actorFor,
}) => {
  const { tenancy, timezones, foreign, ada } = await seed('dev').pick({
    tenancy: 'post:tenancy',
    timezones: 'post:timezones',
    foreign: 'post:offline', // Tinta's — read under Acme it is not there
    ada: 'member:ada',
  });

  const result = await summarizePosts.as(actorFor(ada), {
    orgId: tenancy.orgId,
    postIds: [timezones.id, foreign.id, tenancy.id],
  });

  expect(result.members.map((member) => [member.index, member.status])).toEqual([
    [0, 'ok'],
    [1, 'failed'],
    [2, 'ok'],
  ]);
  expect({ ok: result.ok, failed: result.failed }).toEqual({ ok: 2, failed: 1 });
});

test('summarizePosts is refused for another org before any member runs', async ({
  seed,
  actorFor,
}) => {
  const { tenancy, mara } = await seed('dev').pick({
    tenancy: 'post:tenancy',
    mara: 'member:mara',
  });

  await expect(
    summarizePosts.as(actorFor(mara), { orgId: tenancy.orgId, postIds: [tenancy.id] }),
  ).rejects.toBeUltimateError('X_FORBIDDEN');
  expect(sent).toEqual([]);
});

test('reviewDraft answers a verdict in its schema, from the draft it was pointed at', async ({
  seed,
  actorFor,
}) => {
  const { draft, bruno } = await seed('dev').pick({
    draft: 'post:draft-money',
    bruno: 'member:bruno',
  });

  const review = await reviewDraft.as(actorFor(bruno), { postId: draft.id, orgId: draft.orgId });

  expect(review).toEqual({ verdict: 'revise', notes: 'Say which rounding rule the body defends.' });
  // The draft's own words reached the model — `vars` loaded the row the input named.
  expect(sent.some((prompt) => prompt.includes(draft.title))).toBe(true);
});

test('reviewDraft is refused for a member of another org, at no cost', async ({
  seed,
  actorFor,
}) => {
  const { draft, mara } = await seed('dev').pick({
    draft: 'post:draft-money',
    mara: 'member:mara',
  });

  await expect(
    reviewDraft.as(actorFor(mara), { postId: draft.id, orgId: draft.orgId }),
  ).rejects.toBeUltimateError('X_FORBIDDEN');
  expect(sent).toEqual([]);
});

test('requestPostsExport enqueues one export for an admin and answers where it will land', async ({
  seed,
  actorFor,
  runJobs,
}) => {
  const { ada, bruno } = await seed('dev').pick({ ada: 'member:ada', bruno: 'member:bruno' });
  const orgId = ada.orgId;

  const started = await requestPostsExport.as(actorFor(ada), { orgId });

  expect(started.prefix).toBe(postsExportPrefix({ orgId, exportId: started.exportId }));
  expect(await runJobs.depth(exportPosts)).toBe(1);
  // An author writes posts; exporting the whole org's is an admin's right.
  await expect(requestPostsExport.as(actorFor(bruno), { orgId })).rejects.toBeUltimateError(
    'X_FORBIDDEN',
  );
  expect(await runJobs.depth(exportPosts)).toBe(1);
});
