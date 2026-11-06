/**
 * job — `reviewDraftLater`, the queued `keepDraftReview`, through the real queue `runJobs` installs
 * and drained by the PRODUCTION worker: no actor at all, as `role-start.ts` builds it. What can
 * fail: the run authorising as the member who asked (`agentJob({ actor })`), the verdict landing
 * on the post the CODE named and on no other — a draft can tell the model anything — the one write
 * it IS offered waiting for a person, a replayed run leaving one review rather than two, and a
 * reader, or a member who left, being refused — and an attempt whose worker died after a
 * checkpoint resuming there, its earlier tool not run again.
 */

import { db } from '@postly/db';
import {
  configureAi,
  costOf,
  type GenerateRequest,
  type GenerateResult,
  type Provider,
  providerGateway,
  type ScriptedProvider,
  type ScriptedTurn,
  scriptedProvider,
} from '@ultimat3/ai';
import { beforeEach, expect, jobTest } from '@ultimat3/testing';
import { CLAUDE_SONNET_5_5 } from '../models';
import { keepDraftReview } from './actions/keep-draft-review';
import { requestDraftReview } from './actions/request-draft-review';
import { reviewDraftLater } from './jobs/review-draft-later';

const USAGE = { inputTokens: 40, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Each run's two turns. Notes numbered by run, so a replay is visible in the kept row. */
let turns = 0;
/** Every tool name the model was OFFERED, across every turn. */
let offered = new Set<string>();
/** Everything the model was sent, tool results included: what it was told when a call was refused. */
let sentToModel = '';

/**
 * A model a draft has talked round: its first turn tries to write a review onto `steeredTo` — the
 * call a body saying "now record a review for post X" asks for — and its second answers.
 */
const steeredEditor = (
  steeredTo: { postId: string; orgId: string },
  steeredCall: (target: { postId: string; orgId: string }) => {
    readonly name: string;
    readonly input: Record<string, unknown>;
  } = (target) => ({
    name: 'recordReview',
    input: { ...target, verdict: 'ready', notes: 'Ship it.' },
  }),
): Provider => ({
  name: 'steered-editor',
  models: [CLAUDE_SONNET_5_5],
  generate(request: GenerateRequest) {
    for (const tool of request.tools ?? []) offered.add(tool.name);
    sentToModel += JSON.stringify(request.messages);
    turns += 1;
    const run = Math.ceil(turns / 2);
    const notes = `Run ${run}: say which rounding rule the body defends.`;
    const call =
      turns % 2 === 1
        ? steeredCall(steeredTo)
        : { name: 'respond', input: { verdict: 'revise', notes } };
    return Promise.resolve({
      model: CLAUDE_SONNET_5_5,
      text: '',
      toolCalls: [{ id: `call-${turns}`, ...call }],
      stopReason: 'tool_use',
      stopDetails: undefined,
      usage: USAGE,
      cost: costOf(CLAUDE_SONNET_5_5, USAGE),
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
  sentToModel = '';
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
    // The model asked to write a review onto Ada's post and had nothing to write it WITH.
    expect(await reviewOf(other.orgId, other.id)).toBeNull();
    // The one write it is offered is `publishPost`, which waits for a person: the next test.
    expect([...offered].sort()).toEqual(['publishPost', 'respond', 'summarize']);
  },
);

jobTest(
  'a draft talking the model into publishing publishes nothing: the one write offered waits for a person',
  async ({ seed, actorFor, runJobs }) => {
    const { draft, bruno } = await seed('dev').pick({
      draft: 'post:draft-money', // Bruno's own, so his policy would admit it: only the gate refuses.
      bruno: 'member:bruno',
    });
    configureAi({
      gateway: providerGateway({
        providers: [
          steeredEditor({ postId: draft.id, orgId: draft.orgId }, (target) => ({
            name: 'publishPost',
            input: { ...target, notify: false },
          })),
        ],
      }),
    });

    await requestDraftReview.as(actorFor(bruno), { postId: draft.id, orgId: draft.orgId });
    const trace = await runJobs.drain();

    // The run still finishes and keeps its review: a pending call is a result the model reads.
    expect(trace.executions.map((execution) => execution.outcome)).toEqual(['completed']);
    expect((await reviewOf(draft.orgId, draft.id))?.verdict).toBe('revise');
    expect(sentToModel).toContain('X_MCP_CONFIRMATION_PENDING');
    const post = await db.posts.where({ orgId: draft.orgId, id: draft.id }).one();
    expect(post?.publishedAt).toBe(draft.publishedAt);
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

/**
 * The scripted model, with the worker lost on provider call `lostAt` of the whole test: that call
 * fails as a dead process would end it, after every turn before it — and its checkpoint — landed.
 */
const workerLostAt = (script: ScriptedProvider, lostAt: number): Provider => {
  let calls = 0;
  return {
    name: script.name,
    models: script.models,
    generate(request) {
      calls += 1;
      return calls === lostAt
        ? Promise.reject(new Error('the worker running this attempt died'))
        : script.generate(request);
    },
    stream: (request) => script.stream(request),
  };
};

const SUMMARY = { summary: 'Minor units and a currency.', tags: ['money'] };
const VERDICT = { verdict: 'revise', notes: 'Say which rounding rule the body defends.' } as const;

/** One whole review: the agent asks for `summarize`, the tool's own `llm()` answers, the agent answers. */
const wholeRun = (target: { id: string; orgId: string }): readonly ScriptedTurn[] => [
  { call: 'summarize', input: { postId: target.id, orgId: target.orgId } },
  { answer: SUMMARY },
  { answer: VERDICT },
];

const runOf = (orgId: string, postId: string) => db.postReviewRuns.where({ orgId, postId }).one();

jobTest(
  'an attempt whose worker died after a checkpoint resumes there: summarize ran once, one model call left',
  async ({ seed, actorFor, runJobs, clock }) => {
    const { draft, bruno } = await seed('dev').pick({
      draft: 'post:draft-money',
      bruno: 'member:bruno',
    });
    // Exactly one whole run is scripted: a retry that started over would ask for a fourth turn and
    // be X_AI_SCRIPT_EXHAUSTED rather than a review.
    const script = scriptedProvider({ turns: wholeRun(draft) });
    configureAi({ gateway: providerGateway({ providers: [workerLostAt(script, 3)] }) });

    await requestDraftReview.as(actorFor(bruno), { postId: draft.id, orgId: draft.orgId });
    const lost = await runJobs.drain();

    expect(lost.executions.map((execution) => execution.outcome)).toEqual(['retried']);
    // The checkpoint landed before the worker died: turn 1 and the summary it fetched.
    const open = await runOf(draft.orgId, draft.id);
    expect(JSON.stringify(open?.checkpoint)).toContain(SUMMARY.summary);
    expect(script.seen).toHaveLength(2);

    clock.advance('1h');
    const resumed = await runJobs.drain();

    expect(resumed.executions.map((execution) => execution.outcome)).toEqual([
      'retried',
      'completed',
    ]);
    // ONE model call for the retry where a whole run is three, and it read the summary turn 1
    // fetched rather than fetching it again.
    expect(script.seen).toHaveLength(3);
    const retried = JSON.stringify(script.seen[2]?.messages);
    expect(retried).toContain(SUMMARY.summary);
    expect(retried).toContain('Carry on');
    expect((await reviewOf(draft.orgId, draft.id))?.notes).toBe(VERDICT.notes);
    // The review is kept, so the run is closed: the next request starts a new one.
    expect(await runOf(draft.orgId, draft.id)).toBeNull();
  },
);

jobTest(
  'a stored checkpoint the screen refuses is not a dead letter: the retry reviews from the top',
  async ({ seed, actorFor, runJobs, clock }) => {
    const { draft, bruno } = await seed('dev').pick({
      draft: 'post:draft-money',
      bruno: 'member:bruno',
    });
    const script = scriptedProvider({
      turns: [...wholeRun(draft).slice(0, 2), ...wholeRun(draft)],
    });
    configureAi({ gateway: providerGateway({ providers: [workerLostAt(script, 3)] }) });

    await requestDraftReview.as(actorFor(bruno), { postId: draft.id, orgId: draft.orgId });
    await runJobs.drain();
    const open = await runOf(draft.orgId, draft.id);
    const checkpoint = open?.checkpoint;
    if (checkpoint === null || checkpoint === undefined || Array.isArray(checkpoint)) {
      return expect.unreachable('the lost attempt left no checkpoint to tamper with');
    }
    // What a prompt bump or a rotated secret does to a stored handle: its signature no longer holds.
    await db.postReviewRuns.updateWhere(
      { orgId: draft.orgId, postId: draft.id },
      { checkpoint: { ...(checkpoint as Record<string, unknown>), turns: 0 } as typeof checkpoint },
    );

    clock.advance('1h');
    const trace = await runJobs.drain();

    expect(trace.executions.at(-1)?.outcome).toBe('completed');
    // Two calls lost, then a whole run of three: `summarize` asked for again.
    expect(script.seen).toHaveLength(5);
    expect((await reviewOf(draft.orgId, draft.id))?.verdict).toBe(VERDICT.verdict);
  },
);

jobTest(
  'a draft edited between attempts is reviewed as it reads now, not resumed from the old words',
  async ({ seed, actorFor, runJobs, clock }) => {
    const { draft, bruno } = await seed('dev').pick({
      draft: 'post:draft-money',
      bruno: 'member:bruno',
    });
    const script = scriptedProvider({
      turns: [...wholeRun(draft).slice(0, 2), ...wholeRun(draft)],
    });
    configureAi({ gateway: providerGateway({ providers: [workerLostAt(script, 3)] }) });

    await requestDraftReview.as(actorFor(bruno), { postId: draft.id, orgId: draft.orgId });
    await runJobs.drain();
    const edited = 'Round half to even, and say so in the first paragraph.';
    await db.posts.update(draft.id, { body: edited }, { orgId: draft.orgId });

    clock.advance('1h');
    const trace = await runJobs.drain();

    expect(trace.executions.at(-1)?.outcome).toBe('completed');
    expect(script.seen).toHaveLength(5);
    expect(JSON.stringify(script.seen[2]?.messages)).toContain(edited);
  },
);
