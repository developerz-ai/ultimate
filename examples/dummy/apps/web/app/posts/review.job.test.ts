/**
 * job — `reviewDraftLater`, the queued `reviewDraft`, through the real queue `runJobs` installs and
 * drained by the PRODUCTION worker: no actor at all, as `role-start.ts` builds it. What can fail:
 * the run authorising as the member who asked (`agentJob({ actor })`), the verdict landing where
 * the member reads it (`recordReview`, because a queued run keeps no output), a replayed run
 * leaving one review rather than two, and a member who left being refused rather than trusted.
 */

import { db } from '@postly/db';
import {
  configureAi,
  costOf,
  type GenerateResult,
  type Provider,
  providerGateway,
} from '@ultimat3/ai';
import { beforeEach, expect, jobTest } from '@ultimat3/testing';
import { CLAUDE_SONNET_5 } from '../models';
import { requestDraftReview, reviewDraftLater } from './actions';

const USAGE = { inputTokens: 40, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Each run's two turns: keep the review, then answer it. Notes numbered, so a replay is visible. */
let turns = 0;

/** A model that follows the prompt's rule: `recordReview` once, then the answer. */
const editor = (target: { postId: string; orgId: string }): Provider => ({
  name: 'scripted-editor',
  models: [CLAUDE_SONNET_5],
  generate() {
    turns += 1;
    const run = Math.ceil(turns / 2);
    const notes = `Run ${run}: say which rounding rule the body defends.`;
    const call =
      turns % 2 === 1
        ? { name: 'recordReview', input: { ...target, verdict: 'revise', notes } }
        : { name: 'respond', input: { verdict: 'revise', notes } };
    return Promise.resolve({
      model: CLAUDE_SONNET_5,
      text: '',
      toolCalls: [{ id: `call-${turns}`, ...call }],
      stopReason: 'tool_use',
      stopDetails: undefined,
      usage: USAGE,
      cost: costOf(CLAUDE_SONNET_5, USAGE),
    } satisfies GenerateResult);
  },
  stream() {
    return expect.unreachable('a review is never streamed');
  },
});

beforeEach(() => {
  turns = 0;
});

jobTest(
  'a queued review runs as the member who asked, on the production worker, and is kept',
  async ({ seed, actorFor, runJobs }) => {
    const { draft, bruno } = await seed('dev').pick({
      draft: 'post:draft-money',
      bruno: 'member:bruno',
    });
    configureAi({
      gateway: providerGateway({ providers: [editor({ postId: draft.id, orgId: draft.orgId })] }),
    });

    await requestDraftReview.as(actorFor(bruno), { postId: draft.id, orgId: draft.orgId });
    expect(await runJobs.depth(reviewDraftLater)).toBe(1);
    // No `actor`: the worker is nobody, exactly as in production. The run re-reads bruno.
    const trace = await runJobs.drain();

    expect(trace.executions.map((execution) => execution.outcome)).toEqual(['completed']);
    const review = await db.postReviews.where({ orgId: draft.orgId, postId: draft.id }).one();
    expect(review?.verdict).toBe('revise');
    expect(review?.reviewedBy).toBe(bruno.id);
  },
);

jobTest(
  'a replayed run writes the same review again — one row, never two',
  async ({ seed, runJobs }) => {
    const { draft, bruno } = await seed('dev').pick({
      draft: 'post:draft-money',
      bruno: 'member:bruno',
    });
    configureAi({
      gateway: providerGateway({ providers: [editor({ postId: draft.id, orgId: draft.orgId })] }),
    });
    const input = { postId: draft.id, orgId: draft.orgId, memberId: bruno.id };

    // The whole agent twice, from the top — what an attempt that lost its lease does.
    await runJobs(reviewDraftLater, input);
    await runJobs(reviewDraftLater, input);

    const rows = await db.postReviews.where({ orgId: draft.orgId, postId: draft.id }).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.notes).toStartWith('Run 2:');
  },
);

jobTest(
  'a member of another org named in the payload is not found, and nothing is written',
  async ({ seed, runJobs }) => {
    const { draft, mara } = await seed('dev').pick({
      draft: 'post:draft-money',
      mara: 'member:mara',
    });
    configureAi({
      gateway: providerGateway({ providers: [editor({ postId: draft.id, orgId: draft.orgId })] }),
    });

    const trace = await runJobs(reviewDraftLater, {
      postId: draft.id,
      orgId: draft.orgId,
      memberId: mara.id,
    });

    expect(trace.executions.at(-1)?.outcome).not.toBe('completed');
    // Refused by the re-read, under the org the job declared — not by a worker that is nobody.
    expect(trace.executions.at(-1)?.error).toContain('X_ORG_NOT_FOUND');
    expect(turns).toBe(0);
    expect(await db.postReviews.where({ orgId: draft.orgId, postId: draft.id }).count()).toBe(0);
  },
);
