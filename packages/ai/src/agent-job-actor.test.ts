/**
 * `agentJob({ actor })` — a queued agent acting FOR the member who asked, re-resolved per attempt.
 *
 * The defect this file exists for: a production worker's context carries the ANONYMOUS actor
 * (`role-start.ts` builds it with none), so an agent whose policy reads a member — every real
 * app's — was `X_UNAUTHENTICATED` on its first claim, while `agent-job.test.ts`'s worker, which
 * hands the run a user actor, stayed green. The worker below is the production one.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { resetActions } from '@ultimat3/action';
import type { Actor } from '@ultimat3/core';
import { ctxOf, userActor } from '@ultimat3/core';
import type { ClaimedJob, JobDriver, JobExecution, JobHandle } from '@ultimat3/jobs';
import {
  executeJob,
  memoryJobDriver,
  resetJobDriver,
  resetJobs,
  resetJobsFacade,
  setJobDriver,
} from '@ultimat3/jobs';
import { can, definePermissions } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import { agentJob } from './agent-job';
import { echoProvider } from './echo-provider';
import { providerGateway } from './gateway';
import { FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import { definePrompt } from './prompt';
import type { GenerateResult, Provider, TokenUsage } from './provider';
import { costOf } from './provider';
import { configureAi, resetAiRuntime } from './runtime';

useFixtureModels();
definePermissions(['draft:review']);

const Input = t.object({ topic: t.string, orgId: t.string, memberId: t.string });
type In = { topic: string; orgId: string; memberId: string };

/** The member the run acts for: holds the permission, in the org the input names. */
const member = (id: string, orgId: string): Actor =>
  userActor({ id, orgId, permissions: ['draft:review'] });

/** Every actor the policy was asked about, in order. */
let asked: (Actor | null)[] = [];

/** A member rule, as an app writes one: the grant, then the org the input names. */
const memberRule = can<In>('draft:review', ({ actor, input }) => {
  asked.push(actor);
  return actor?.orgId === input.orgId;
});

const USAGE: TokenUsage = {
  inputTokens: 8,
  outputTokens: 4,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** Answers through `respond` on the first turn: the run completes when the policy lets it start. */
const answering: Provider = {
  name: 'answering',
  models: [FIXTURE_MODEL],
  generate: () =>
    Promise.resolve({
      model: FIXTURE_MODEL,
      text: '',
      toolCalls: [{ id: 'c1', name: 'respond', input: { text: 'ready' } }],
      stopReason: 'tool_use',
      stopDetails: undefined,
      usage: USAGE,
      cost: costOf(FIXTURE_MODEL, USAGE),
    } satisfies GenerateResult),
  stream: (request) => echoProvider().stream(request),
};

let seq = 0;
const reviewer = () => {
  seq += 1;
  return agent({
    input: Input,
    output: t.object({ text: t.string }),
    prompt: definePrompt<{ topic: string }>({
      id: `agentjob-actor-${seq}`,
      version: '1.0.0',
      template: 'Review {{topic}}.',
    }),
    vars: ({ input }) => ({ topic: input.topic }),
    tools: [],
    policy: memberRule,
  }).named(`reviewer${seq}`);
};

/** The production worker: no actor at all, as `role-start.ts` builds it. */
async function run(handle: JobHandle<In>, input: In): Promise<JobExecution> {
  await handle.enqueue(input);
  const [claimed] = await driver.claim({
    queues: [handle.queue],
    limit: 1,
    visibilityTimeoutMs: 30_000,
    workerId: 'worker-test',
  });
  return executeJob({
    driver,
    claimed: claimed as ClaimedJob,
    handle,
    ctx: ctxOf({ role: 'worker' }),
  });
}

let driver: JobDriver;

beforeEach(() => {
  asked = [];
  resetAiRuntime();
  resetActions();
  resetJobs();
  resetJobsFacade();
  driver = memoryJobDriver();
  setJobDriver(driver);
  configureAi({
    gateway: providerGateway({ defaultModel: FIXTURE_MODEL, providers: [answering] }),
  });
});

afterAll(() => {
  resetJobs();
  resetJobDriver();
});

const INPUT: In = { topic: 'a draft', orgId: 'org-1', memberId: 'member-7' };

describe('agentJob({ actor }) — the run acts for the member its input names', () => {
  test('without it, a member policy refuses the production worker: the run cannot authorise', async () => {
    const handle = agentJob(reviewer(), {
      name: 'review-anonymous',
      tenant: (input) => input.orgId,
      retry: { attempts: 1 },
    });
    const execution = await run(handle, INPUT);
    expect(execution.outcome).not.toBe('completed');
    expect(execution.error).toContain('X_UNAUTHENTICATED');
  });

  test('with it, the policy decides about the resolved member, on the record as the worker', async () => {
    const resolved: string[] = [];
    const handle = agentJob(reviewer(), {
      name: 'review-as-member',
      tenant: (input) => input.orgId,
      retry: { attempts: 1 },
      actor: ({ input }) => {
        resolved.push(input.memberId);
        return member(input.memberId, input.orgId);
      },
    });
    const execution = await run(handle, INPUT);
    expect(execution.outcome).toBe('completed');
    expect(resolved).toEqual(['member-7']);
    const seen = asked.at(-1);
    expect(seen?.id).toBe('member-7');
    expect(seen?.orgId).toBe('org-1');
    // Impersonation, never a quiet swap: the worker that performed it stays on the actor.
    expect(seen?.onBehalfOf?.actorKind).toBe('anonymous');
  });

  test('a resolved actor in another org than the declared tenant is refused before the agent runs', async () => {
    const handle = agentJob(reviewer(), {
      name: 'review-wrong-org',
      tenant: (input) => input.orgId,
      retry: { attempts: 1 },
      actor: ({ input }) => member(input.memberId, 'org-2'),
    });
    const execution = await run(handle, INPUT);
    expect(execution.outcome).not.toBe('completed');
    expect(execution.error).toContain('org-2');
    // The policy was never asked: the refusal is the declaration's, before any turn.
    expect(asked).toEqual([]);
  });

  test('a resolver that cannot find the member fails the attempt with its own error', async () => {
    const handle = agentJob(reviewer(), {
      name: 'review-member-gone',
      tenant: (input) => input.orgId,
      retry: { attempts: 1 },
      actor: () => Promise.reject(new RangeError('member-7 left the org')),
    });
    const execution = await run(handle, INPUT);
    expect(execution.outcome).not.toBe('completed');
    expect(execution.error).toContain('member-7 left the org');
    expect(asked).toEqual([]);
  });
});
