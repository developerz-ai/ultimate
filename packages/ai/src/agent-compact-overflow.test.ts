/**
 * A provider that refuses a turn as over the window (`X_AI_CONTEXT_OVERFLOW`) is not the end of the
 * run: the loop still holds the transcript, so it compacts once and re-sends. A second refusal, a
 * compaction that cannot be had, or `compact: 'off'` is `X_AGENT_CONTEXT_EXHAUSTED`, terminal —
 * and an `agentJob` dead-letters it on attempt one instead of re-buying every turn.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { resetActions } from '@ultimat3/action';
import {
  ctxOf,
  declaredErrorRetry,
  registerErrorRetry,
  stringField,
  userActor,
} from '@ultimat3/core';
import type { ClaimedJob, JobDriver } from '@ultimat3/jobs';
import {
  executeJob,
  memoryJobDriver,
  resetJobDriver,
  resetJobs,
  resetJobsFacade,
  setJobDriver,
} from '@ultimat3/jobs';
import type { AgentCompaction } from './agent';
import { dense, denseAgent, OVERFLOW_TEXT } from './agent-compact-dense-fixture';
import { compactedHead, ctx, INPUT, ROOM, SUMMARY_USAGE } from './agent-compact-fixture';
import { agentJob } from './agent-job';
import { AI_ERROR_RETRY } from './errors-retry';
import { useFixtureModels } from './model-fixture';

useFixtureModels();

// Four turns kept: the summary call is the refused request less them plus one instruction, so it
// must come out shorter than the request the provider just refused, or it overflows as well.
const RULE = { keepTurns: 4 } as const;

/**
 * Refused when the request really is over the room — and, once refused, refused for good: the
 * provider that will not take this transcript in any shape.
 */
const refusedForGood = () => {
  let refused = false;
  return (_call: number, real: number): boolean => {
    if (real > ROOM) refused = true;
    return refused;
  };
};

const failure = (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => expect.unreachable('the run answered'),
    (error: unknown) => error,
  );

const metaOf = (error: unknown): Readonly<Record<string, unknown>> =>
  (error as { meta?: Readonly<Record<string, unknown>> }).meta ?? {};

let driver: JobDriver;
beforeEach(() => {
  registerErrorRetry(AI_ERROR_RETRY);
  resetActions();
  resetJobs();
  resetJobsFacade();
  driver = memoryJobDriver();
  setJobDriver(driver);
});

afterAll(() => {
  resetJobs();
  resetJobDriver();
});

describe('one overflow recovers', () => {
  test('compacts regardless of the trigger, re-sends the same turn, and bills one summary', async () => {
    // Reporting no usage, the run has only the estimate — which says it fits — until the 400.
    const run = dense({ reads: 18, reports: 'zero' });
    const events: AgentCompaction[] = [];
    const answered = await denseAgent(RULE, events, 30).run(INPUT, { ctx: ctx() });

    expect(answered.output).toEqual({ title: 'Rows' });
    const refused = run.refused[0] ?? expect.unreachable('the provider never refused');
    expect(run.refused).toEqual([refused]);
    expect(run.summaries.length).toBe(1);
    const forced = events[0] ?? expect.unreachable('no compaction');
    expect(forced).toMatchObject({ turn: refused, outcome: 'compacted' });
    // `before` is what the refusal measured: over the room, whatever the estimate said.
    expect(forced.before).toBeGreaterThan(ROOM);
    // The re-send is the compacted same turn; the refused one did not count as a turn.
    expect(compactedHead(run.loop[refused]?.messages[0])).toBe(true);
    expect(answered.turns).toBe(run.loop.length - 1);
    // Every answered loop call reported 20 output tokens; the summary 40; the refusal nothing.
    expect(answered.usage.usage.outputTokens).toBe(
      (run.loop.length - 1) * 20 + SUMMARY_USAGE.outputTokens,
    );
  });
});

describe('X_AGENT_CONTEXT_EXHAUSTED, terminal', () => {
  test('a second overflow after the forced compaction stops the run with the provider text', async () => {
    const run = dense({ reads: 18, reports: 'zero', refuse: refusedForGood() });
    const error = await failure(denseAgent(RULE, [], 30)(INPUT, { ctx: ctx() }));

    expect(stringField(error, 'code')).toBe('X_AGENT_CONTEXT_EXHAUSTED');
    expect(metaOf(error)['refused']).toBe(OVERFLOW_TEXT);
    expect(stringField(error, 'cause')).toContain('refused by the provider');
    expect((JSON.parse(JSON.stringify(error)) as { retry?: unknown }).retry).toBe('terminal');
    expect(declaredErrorRetry('X_AGENT_CONTEXT_EXHAUSTED')).toBe('terminal');
    // Refused, compacted once, refused again — never a third send.
    const first = run.refused[0] ?? expect.unreachable('the provider never refused');
    expect(run.refused).toEqual([first, first + 1]);
    expect(run.loop.length).toBe(first + 1);
    expect(run.summaries.length).toBe(1);
  });

  test("compact: 'off' makes no second call", async () => {
    const run = dense({ reads: 18, reports: 'zero' });
    const error = await failure(denseAgent('off', [], 30)(INPUT, { ctx: ctx() }));
    expect(stringField(error, 'code')).toBe('X_AGENT_CONTEXT_EXHAUSTED');
    expect(metaOf(error)['refused']).toBe(OVERFLOW_TEXT);
    expect(run.refused.length).toBe(1);
    expect(run.loop.length).toBe(run.refused[0] ?? expect.unreachable('never refused'));
    expect(run.summaries.length).toBe(0);
  });

  test('nothing old enough to summarise is exhausted at once, with no re-send', async () => {
    const run = dense({ reads: 9, refuse: (call) => call === 2 });
    const events: AgentCompaction[] = [];
    const error = await failure(denseAgent(RULE, events)(INPUT, { ctx: ctx() }));
    expect(stringField(error, 'code')).toBe('X_AGENT_CONTEXT_EXHAUSTED');
    expect(events.map((event) => event.outcome)).toEqual(['failed']);
    expect(metaOf(error)['refused']).toBe(OVERFLOW_TEXT);
    expect(run.loop.length).toBe(2);
  });
});

describe('agentJob()', () => {
  test('an overflow that cannot recover dead-letters on attempt one', async () => {
    const run = dense({ reads: 18, reports: 'zero', refuse: refusedForGood() });
    const handle = agentJob(denseAgent(RULE, [], 30), {
      name: 'overflow-job',
      tenant: 'none',
      retry: { attempts: 3, jitter: false },
    });
    await handle.enqueue(INPUT);
    const claimed = (
      await driver.claim({
        queues: [handle.queue],
        limit: 1,
        visibilityTimeoutMs: 30_000,
        workerId: 'worker-test',
      })
    )[0] as ClaimedJob;
    const workerCtx = ctxOf({ role: 'worker', actor: userActor({ id: 'w-1', orgId: 'org-1' }) });
    const execution = await executeJob({ driver, claimed, handle, ctx: workerCtx });
    expect(execution.error).toContain('X_AGENT_CONTEXT_EXHAUSTED');
    expect(execution.outcome).toBe('dead-lettered');
    // One attempt: refused, compacted, refused — never the run bought again.
    expect(run.refused.length).toBe(2);
    expect(run.loop.length).toBe((run.refused[0] ?? 0) + 1);
  });
});
