// A job that dies at step 3 becomes a test that replays steps 1 and 2 from their stored output and
// fails at step 3 — read off a real run on the memory driver, through `inspectJob`, as `x repro`
// reads it. The written source carries the step names and outputs, so renaming one changes it.

import { afterEach, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { inspectJob, job, jobDriver, resetJobDriver, t } from '@ultimat3/jobs';
import { testJobs } from '@ultimat3/testing';
import { jobFailureOf, jobFingerprint, jobTestSource } from './repro-job';

let minted = 0;
const threeSteps = (last: string) => {
  minted += 1;
  return job<{ id: string; apiKey: string }>({
    name: `repro-job-${String(minted)}`,
    input: t.object({ id: t.string, apiKey: t.string }),
    tenant: 'none',
    idempotencyKey: (input) => input.id,
    retry: { attempts: 1, jitter: false },
    run: async ({ step }) => {
      const a = await step.run('fetch', async () => 20);
      await step.run('double', async () => a * 2);
      await step.run(last, async () => {
        throw new UltimateError({ code: 'X_PLANTED_FAILURE', cause: 'planted', fix: 'x verify' });
      });
    },
  });
};

afterEach(() => resetJobDriver());

const deadJob = async (last: string) => {
  const handle = threeSteps(last);
  await using runJobs = await testJobs();
  const trace = await runJobs(handle, { id: 'a', apiKey: 'k-planted-secret' });
  const jobId = trace.executions[0]?.jobId ?? '';
  const driver = jobDriver();
  if (driver === undefined) return expect.unreachable('testJobs installed no driver');
  const inspected = await inspectJob(driver, jobId);
  if (inspected === undefined) return expect.unreachable('the dead job was not found');
  return jobFailureOf(inspected, await driver.steps.list(inspected.runId));
};

test('steps 1 and 2 replay from their output; the failure is pinned at step 3 with its code', async () => {
  const failure = await deadJob('charge');
  expect(failure.steps).toEqual([
    { name: 'fetch', output: 20 },
    { name: 'double', output: 40 },
  ]);
  expect([failure.code, failure.step]).toEqual(['X_PLANTED_FAILURE', 'charge']);
  // `x jobs show`'s masking, then listed: the secret never reaches the bundle or the file.
  expect(failure.masked).toEqual(['apiKey']);
  const source = jobTestSource(failure, { id: failure.jobId, imports: ['../apps/web/api'] });
  expect(source).toContain("import '../apps/web/api';");
  expect(source).toContain('reproJob(runJobs, FAILURE)');
  expect(source).not.toContain('k-planted-secret');
  expect(jobFingerprint(failure)).toMatch(/^[0-9a-f]{16}$/);
});

test('a renamed failing step writes a different file', async () => {
  const one = await deadJob('charge');
  const two = await deadJob('settle');
  const meta = { id: 'same', imports: [] };
  expect(jobTestSource({ ...one, jobId: 'x', name: 'n' }, meta)).not.toBe(
    jobTestSource({ ...two, jobId: 'x', name: 'n' }, meta),
  );
});
