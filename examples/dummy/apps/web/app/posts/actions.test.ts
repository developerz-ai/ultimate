/**
 * unit — `requestPostsExport`, and the posts feature's model-backed actions, `summarizePosts` (a `hive()`) and `reviewDraft`
 * (an `agent()`), against a deterministic provider installed as the app's AI runtime. What is
 * asserted is the factory's contract as this app relies on it: members in the order asked, one
 * unreadable post failing alone, the agent's tool call and its answer parsed into its schema, and a
 * refusal decided before a single token is spent. The agent runs on `scriptedProvider`, because
 * echo cannot call a tool.
 */

import {
  configureAi,
  echoProvider,
  meteredRun,
  providerGateway,
  scriptedProvider,
} from '@ultimat3/ai';
import { beforeEach, expect, test } from '@ultimat3/testing';
import { requestPostsExport } from './actions/request-posts-export';
import { reviewDraft } from './actions/review-draft';
import { summarizePosts } from './actions/summarize-posts';
import { exportPosts, postsExportPrefix } from './jobs/export-posts';

/** Every prompt the provider was sent, so a refusal can be shown to have cost nothing. */
const sent: string[] = [];

/** The summariser's answer, in its declared schema, for every post the hive fans out over. */
const answer = (prompt: string): string => {
  sent.push(prompt);
  return JSON.stringify({ summary: 'Minor units and a currency.', tags: ['money'] });
};

// Installed fresh per test: `configureAi` replaces the runtime and clears the semantic cache, so no
// test answers from a summary another one cached.
beforeEach(() => {
  sent.length = 0;
  configureAi({ gateway: providerGateway({ providers: [echoProvider({ fallback: answer })] }) });
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

test('reviewDraft calls its summarize tool, then answers a verdict in its schema', async ({
  seed,
  actorFor,
}) => {
  const { draft, bruno } = await seed('dev').pick({
    draft: 'post:draft-money',
    bruno: 'member:bruno',
  });
  // Three model calls, in order: the agent asks for `summarize`, the tool's own `llm()` answers,
  // the agent answers. A fourth would be X_AI_SCRIPT_EXHAUSTED, never the last turn again.
  const model = scriptedProvider({
    turns: [
      { call: 'summarize', input: { postId: draft.id, orgId: draft.orgId } },
      { answer: { summary: 'Minor units and a currency.', tags: ['money'] } },
      { answer: { verdict: 'revise', notes: 'Say which rounding rule the body defends.' } },
    ],
  });
  configureAi({ gateway: providerGateway({ providers: [model] }) });

  const { value, billed } = await meteredRun(() =>
    reviewDraft.as(actorFor(bruno), { postId: draft.id, orgId: draft.orgId }),
  );

  expect(value).toEqual({ verdict: 'revise', notes: 'Say which rounding rule the body defends.' });
  // The draft's own words reached the model — `vars` loaded the row the input named.
  expect(JSON.stringify(model.seen[0]?.messages)).toContain(draft.title);
  // The tool's summary is what the agent's last turn read.
  expect(JSON.stringify(model.seen[2]?.messages)).toContain('Minor units and a currency.');
  // One bill for the run, the tool's model call included.
  expect(billed?.calls).toBe(3);
});

test('reviewDraft is refused for a member of another org, at no cost', async ({
  seed,
  actorFor,
}) => {
  const { draft, mara } = await seed('dev').pick({
    draft: 'post:draft-money',
    mara: 'member:mara',
  });
  const model = scriptedProvider({ turns: [] });
  configureAi({ gateway: providerGateway({ providers: [model] }) });

  await expect(
    reviewDraft.as(actorFor(mara), { postId: draft.id, orgId: draft.orgId }),
  ).rejects.toBeUltimateError('X_FORBIDDEN');
  expect(model.seen).toEqual([]);
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
