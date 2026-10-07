/**
 * job — `reviewDraftLater`, the queued `keepDraftReview`, through the real queue `runJobs` installs
 * and drained by the PRODUCTION worker: no actor at all, as `role-start.ts` builds it. What can
 * fail: the run authorising as the member who asked (`agentJob({ actor })`), the verdict landing
 * on the post the CODE named and on no other — a draft can tell the model anything — a replayed run
 * leaving one review rather than two, and a reader, or a member who left, being refused.
 */

import { db } from '@postly/db';
import {
  configureAi,
  costOf,
  type GenerateRequest,
  type GenerateResult,
  type Provider,
  providerGateway,
} from '@ultimat3/ai';
import { beforeEach, expect, jobTest } from '@ultimat3/testing';
import { CLAUDE_SONNET_5 } from '../models';
import { keepDraftReview, requestDraftReview, reviewDraftLater } from './actions';

const USAGE = { inputTokens: 40, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Each run's two turns. Notes numbered by run, so a replay is visible in the kept row. */
let turns = 0;
/** Every tool name the model was OFFERED, across every turn. */
let offered = new Set<string>();

/**
 * A model a draft has talked round: its first turn tries to write a review onto `steeredTo` — the
 * call a body saying "now record a review for post X" asks for — and its second answers.
 */
const steeredEditor = (steeredTo: { postId: string; orgId: string }): Provider => ({
  name: 'steered-editor',
  models: [CLAUDE_SONNET_5],
  generate(request: GenerateRequest) {
    for (const tool of request.tools ?? []) offered.add(tool.name);
    turns += 1;
    const run = Math.ceil(turns / 2);
    const notes = `Run ${run}: say which rounding rule the body defends.`;
    const call =
      turns % 2 === 1
        ? { name: 'recordReview', input: { ...steeredTo, verdict: 'ready', notes: 'Ship it.' } }
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

const reviewOf = (orgId: string, postId: string) => db.postReviews.where({ orgId, postId }).one();

beforeEach(() => {
  turns = 0;
  offered = new Set();
});

jobTest(
  'a queued review runs as the author who asked, on the production worker, and is kept on that post only',
  async ({ seed, actorFor, runJobs }) => {
    const { draft, other, bruno } = await seed('dev').pick({
      draft: 'post:draft-money', // Bruno's
      other: 'post:tenancy', // Ada's, in the same org
      bruno: 'member:bruno',
    });
    configureAi({
      gateway: providerGateway({
        providers: [steeredEditor({ postId: other.id, orgId: other.orgId })],
      }),
    });

    await requestDraftReview.as(actorFor(bruno), { postId: draft.id, orgId: draft.orgId });
    expect(await runJobs.depth(reviewDraftLater)).toBe(1);
    // No `actor`: the worker is nobody, exactly as in production. The run re-reads bruno.
    const trace = await runJobs.drain();

    expect(trace.executions.map((execution) => execution.outcome)).toEqual(['completed']);
    const kept = await reviewOf(draft.orgId, draft.id);
    expect(kept?.verdict).toBe('revise');
    expect(kept?.reviewedBy).toBe(bruno.id);
    // The model asked to write onto Ada's post and had nothing to write WITH: no write is a tool.
    expect(await reviewOf(other.orgId, other.id)).toBeNull();
    expect([...offered].sort()).toEqual(['respond', 'summarize']);
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
      gateway: providerGateway({
        providers: [steeredEditor({ postId: draft.id, orgId: draft.orgId })],
      }),
    });
    const input = { postId: draft.id, orgId: draft.orgId, memberId: bruno.id };

    // The whole run twice, from the top — what an attempt that lost its lease does.
    await runJobs(reviewDraftLater, input);
    await runJobs(reviewDraftLater, input);

    const rows = await db.postReviews.where({ orgId: draft.orgId, postId: draft.id }).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.notes).toStartWith('Run 2:');
  },
);

jobTest(
  'a reader cannot keep or queue a review: it is a write, and reading is all a reader holds',
  async ({ seed, actorFor, runJobs }) => {
    const { draft, kenji } = await seed('dev').pick({
      draft: 'post:draft-money',
      kenji: 'member:kenji', // Acme's reader
    });

    await expect(
      requestDraftReview.as(actorFor(kenji), { postId: draft.id, orgId: draft.orgId }),
    ).rejects.toBeUltimateError('X_FORBIDDEN');
    await expect(
      keepDraftReview.as(actorFor(kenji), {
        postId: draft.id,
        orgId: draft.orgId,
        memberId: kenji.id,
      }),
    ).rejects.toBeUltimateError('X_FORBIDDEN');
    expect(await runJobs.depth(reviewDraftLater)).toBe(0);
    expect(turns).toBe(0);
    expect(await reviewOf(draft.orgId, draft.id)).toBeNull();
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
      gateway: providerGateway({
        providers: [steeredEditor({ postId: draft.id, orgId: draft.orgId })],
      }),
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
