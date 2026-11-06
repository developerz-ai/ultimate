// `x jobs resolve-step <id> <step> --ran [--output json] | --not-ran`: a person's answer to
// `X_STEP_OUTCOME_UNKNOWN`, written through the queue's own `resolveStep`, refused at the door
// when it says both, neither, or output that is not JSON. Same harness as `cmd-jobs.test.ts`.

import { afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { JobDriver } from '@ultimat3/jobs';
import { claimOf, memoryJobDriver, resetJobDriver, resetJobs } from '@ultimat3/jobs';
import { enqueue, runJobs } from './cmd-jobs-fixture';
import { msg } from './messages';

afterEach(() => {
  resetJobDriver();
  resetJobs();
});

/** A dead job whose `once` step `send` started and never completed. */
async function unknownOutcome(): Promise<{ driver: JobDriver; id: string; runId: string }> {
  const driver = memoryJobDriver();
  const id = await enqueue(driver, 'payout');
  const [held] = await driver.claim({
    queues: ['default'],
    limit: 1,
    visibilityTimeoutMs: 30_000,
    workerId: 'w-1',
  });
  if (held === undefined) return expect.unreachable('nothing was claimed');
  await driver.steps.put({
    runId: held.runId,
    name: 'send',
    status: 'started',
    startedAt: 1,
    attempts: 0,
  });
  await driver.nack(id, { ...claimOf(held), delayMs: 0, deadLetter: true });
  return { driver, id, runId: held.runId };
}

const codeOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => 'resolved',
    (error: unknown) => (isUltimateError(error) ? error.code : error),
  );

describe('unit · x jobs resolve-step', () => {
  test('--ran records the output a replay will return, and names the retry', async () => {
    const { driver, id, runId } = await unknownOutcome();
    const result = await runJobs(driver, {
      subcommand: 'resolve-step',
      positionals: [id, 'send'],
      flags: { ran: true, output: '{"receipt":"r-1"}' },
    });
    expect(result.summary).toBe(
      msg('cli.jobs.stepResolved', { id, step: 'send', status: 'completed' }),
    );
    expect(await driver.steps.get(runId, 'send')).toMatchObject({
      status: 'completed',
      output: { receipt: 'r-1' },
    });
  });

  test('--not-ran clears the step, so the next run calls it again', async () => {
    const { driver, id, runId } = await unknownOutcome();
    await runJobs(driver, {
      subcommand: 'resolve-step',
      positionals: [id, 'send'],
      flags: { 'not-ran': true },
    });
    expect((await driver.steps.get(runId, 'send'))?.status).toBe('cleared');
  });

  test('both, neither, output with --not-ran, or output that is not JSON: refused, nothing written', async () => {
    const { driver, id, runId } = await unknownOutcome();
    const asked = (flags: Readonly<Record<string, string | boolean>>) =>
      codeOf(runJobs(driver, { subcommand: 'resolve-step', positionals: [id, 'send'], flags }));
    expect(await asked({ ran: true, 'not-ran': true })).toBe('X_CLI_BAD_FLAG');
    expect(await asked({})).toBe('X_CLI_BAD_FLAG');
    expect(await asked({ 'not-ran': true, output: '1' })).toBe('X_CLI_BAD_FLAG');
    expect(await asked({ ran: true, output: '{nope' })).toBe('X_CLI_BAD_FLAG');
    expect((await driver.steps.get(runId, 'send'))?.status).toBe('started');
  });

  test('a missing step positional is refused, naming the command that lists the steps', async () => {
    const { driver, id } = await unknownOutcome();
    expect(
      await codeOf(runJobs(driver, { subcommand: 'resolve-step', positionals: [id], flags: {} })),
    ).toBe('X_CLI_BAD_FLAG');
  });

  test('a step with no unknown outcome is the queue refusal, passed through', async () => {
    const { driver, id } = await unknownOutcome();
    expect(
      await codeOf(
        runJobs(driver, {
          subcommand: 'resolve-step',
          positionals: [id, 'nosuch'],
          flags: { 'not-ran': true },
        }),
      ),
    ).toBe('X_STEP_NOT_RESOLVABLE');
  });
});
