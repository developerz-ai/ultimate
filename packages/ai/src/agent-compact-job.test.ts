/**
 * Compaction in a queued run: `agentJob()` runs the agent's own action, so a long run compacts on
 * the worker as it does in a request — and a run that outgrew the window dead-letters on attempt
 * one instead of being bought again per attempt.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { resetActions } from '@ultimat3/action';
import { ctxOf, registerErrorRetry, userActor } from '@ultimat3/core';
import type { ClaimedJob, JobDriver } from '@ultimat3/jobs';
import {
  executeJob,
  memoryJobDriver,
  resetJobDriver,
  resetJobs,
  resetJobsFacade,
  setJobDriver,
} from '@ultimat3/jobs';
import { ANSWER, declare, READ, scripted } from './agent-compact-fixture';
import { agentJob } from './agent-job';
import { AI_ERROR_RETRY } from './errors-retry';
import { useFixtureModels } from './model-fixture';

useFixtureModels();

const EIGHT_READS = [READ, READ, READ, READ, READ, READ, READ, READ, ANSWER];
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

async function runOnce(name: string, write: ReturnType<typeof declare>) {
  const handle = agentJob(write, { name, tenant: 'none', retry: { attempts: 3, jitter: false } });
  await handle.enqueue({ topic: 'tides' });
  const claimed = (
    await driver.claim({
      queues: [handle.queue],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'worker-test',
    })
  )[0] as ClaimedJob;
  const ctx = ctxOf({ role: 'worker', actor: userActor({ id: 'worker-1', orgId: 'org-1' }) });
  return executeJob({ driver, claimed, handle, ctx });
}

describe('agentJob() compacts like the request path', () => {
  test('a long queued run compacts and finishes', async () => {
    const { summaries } = scripted(EIGHT_READS);
    const execution = await runOnce('compact-long', declare({ compact: { keepTurns: 2 } }));
    expect(execution.outcome).toBe('completed');
    expect(summaries.length).toBeGreaterThan(0);
  });

  test('X_AGENT_CONTEXT_EXHAUSTED is dead-lettered on attempt one', async () => {
    const { loop } = scripted(EIGHT_READS, { text: '' });
    const execution = await runOnce('compact-exhausted', declare({ compact: { keepTurns: 2 } }));
    expect(execution.error).toContain('X_AGENT_CONTEXT_EXHAUSTED');
    expect(execution.outcome).toBe('dead-lettered');
    // One attempt's worth of turns, never three.
    expect(loop.length).toBeLessThan(9);
  });
});
