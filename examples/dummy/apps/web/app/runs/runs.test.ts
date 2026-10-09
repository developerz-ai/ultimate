/**
 * unit — who may do what to a run, and the one guarantee the console is built on: a connection
 * runs ONCE at a time, and the second start is settled `failed` (`X_JOB_KEY_BUSY`) without its
 * body ever running — a declared field of the job, not a guard in the action. The runs go through
 * `runJobs`, whose passes are a real worker's: admission, keyed concurrency and the settle hook.
 */

import { driver } from '@postly/db';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import type { JobDriver, JobRecord } from '@ultimat3/jobs';
import { jobDriver } from '@ultimat3/jobs';
import { testActor } from '@ultimat3/policy';
import { noWaitClock, resetScrapeClock, setScrapeClock } from '@ultimat3/scraping';
import { defineStorage, memoryStorageDriver, resetStorage } from '@ultimat3/storage';
import { afterEach, beforeEach, describe, expect, test, testName } from '@ultimat3/testing';
import { answerPrompt } from './actions/answer-prompt';
import { cancelRun } from './actions/cancel-run';
import { connectSite } from './actions/connect-site';
import { startRun } from './actions/start-run';
import { canRunAct, canRunKey, canRunKeyRevoke, canRunRead, canRunWrite } from './policy';
import * as repo from './repo';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a9';
const input = { orgId: ORG };

const read = 'run:read';
const write = 'run:write';
const key = 'run:key';

const reader = testActor('reader', { orgId: ORG, permissions: [read] }).actor;
const writer = testActor('writer', { orgId: ORG, permissions: [read, write] }).actor;
const admin = testActor('admin', { orgId: ORG, permissions: [read, write, key] }).actor;
const outsider = testActor('outsider', { orgId: OTHER_ORG, permissions: [read, write, key] }).actor;

const own = { orgId: ORG };
const foreign = { orgId: OTHER_ORG };

describe(testName('unit', 'the run rules, from the denial side'), () => {
  test('watching denies anonymous, cross-org and a row from another org', async () => {
    await expect(canRunRead).toDenyPolicy({ actor: null, input });
    await expect(canRunRead).toDenyPolicy({ actor: outsider, input });
    await expect(canRunRead).toDenyPolicy({ actor: reader, input, row: foreign });
    await expect(canRunRead).not.toDenyPolicy({ actor: reader, input });
    await expect(canRunRead).not.toDenyPolicy({ actor: reader, input, row: own });
  });

  test('connecting and starting deny the read-only actor and the outsider', async () => {
    await expect(canRunWrite).toDenyPolicy({ actor: null, input });
    await expect(canRunWrite).toDenyPolicy({ actor: reader, input });
    // Holds the grant and is still denied: the predicate is the second, independent gate.
    await expect(canRunWrite).toDenyPolicy({ actor: outsider, input });
    await expect(canRunWrite).not.toDenyPolicy({ actor: writer, input });
  });

  test('answering and cancelling deny a run nobody loaded, and one from another org', async () => {
    // `row: null` is "no such run in your org" — never evidence the actor may act on one.
    await expect(canRunAct).toDenyPolicy({ actor: writer, input });
    await expect(canRunAct).toDenyPolicy({ actor: writer, input, row: foreign });
    await expect(canRunAct).toDenyPolicy({ actor: reader, input, row: own });
    await expect(canRunAct).toDenyPolicy({ actor: outsider, input, row: own });
    await expect(canRunAct).not.toDenyPolicy({ actor: writer, input, row: own });
  });

  test('issuing and revoking a key are the admin’s, in their own org', async () => {
    await expect(canRunKey).toDenyPolicy({ actor: writer, input });
    await expect(canRunKey).toDenyPolicy({ actor: outsider, input });
    await expect(canRunKey).not.toDenyPolicy({ actor: admin, input });
    await expect(canRunKeyRevoke).toDenyPolicy({ actor: admin, input });
    await expect(canRunKeyRevoke).toDenyPolicy({ actor: admin, input, row: foreign });
    await expect(canRunKeyRevoke).not.toDenyPolicy({ actor: admin, input, row: own });
  });

  test('each rule names the permission it requires', () => {
    expect(canRunRead.permissions).toEqual([read]);
    expect(canRunWrite.permissions).toEqual([write]);
    expect(canRunAct.permissions).toEqual([write]);
    expect(canRunKey.permissions).toEqual([key]);
    expect(canRunKeyRevoke.permissions).toEqual([key]);
  });
});

const rowOf = async (queue: JobDriver | undefined, id: string): Promise<JobRecord> => {
  const row = await queue?.introspect?.job(id);
  return row ?? expect.unreachable(`the queue holds no job ${id}`);
};

/** Macrotasks until `ready` answers: the held run is in flight in this process. */
const until = async <T>(ready: () => Promise<T | null>): Promise<T> => {
  for (let tick = 0; tick < 200; tick += 1) {
    const found = await ready();
    if (found !== null) return found;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return expect.unreachable('the run never reached the state the test waits for');
};

const statusOf = async (runId: string) => (await connectedAs(() => repo.runById(runId)))?.status;

describe(testName('unit', 'one run per connection'), () => {
  beforeEach(() => {
    defineStorage({ disks: { sessions: memoryStorageDriver() } });
    // A parked run looks for its answer once per turn of the event loop, never once per 250 ms.
    setScrapeClock(noWaitClock);
  });

  afterEach(() => {
    resetScrapeClock();
    resetStorage();
    driver.reset?.();
  });

  const connect = () =>
    connectSite.as(writer, { orgId: ORG, label: 'Ledger', credential: 'correct horse battery' });

  test('a second start on a busy connection settles failed, X_JOB_KEY_BUSY', async ({
    runJobs,
  }) => {
    const connection = await connect();
    const first = await startRun.as(writer, { orgId: ORG, connectionId: connection.id });
    const second = await startRun.as(writer, { orgId: ORG, connectionId: connection.id });
    // Two runs, never one deduped: the idempotency key is the start, not the connection.
    expect(second.runId).not.toBe(first.runId);
    expect(await statusOf(second.runId)).toBe('queued');

    // One pass claims both; the worker's admission lets the first hold the connection's key.
    const draining = runJobs.drain();
    // The first run is parked on its prompt, browser open, holding the key.
    await until(() => connectedAs(() => repo.promptEvent(first.runId, 1)));
    // The second's body never ran, and the refusal is on the record: the job was told how it
    // ended, and the console says so instead of waiting for a run that will never start.
    const refusal = await until(async () => {
      const events = await connectedAs(() => repo.eventsOf(second.runId, 50));
      return events.length === 0 ? null : events;
    });
    expect(refusal.map((event) => [event.kind, event.message])).toEqual([
      ['failed', 'X_JOB_KEY_BUSY'],
    ]);
    const refused = await connectedAs(() => repo.runById(second.runId));
    expect([refused?.status, refused?.code]).toEqual(['failed', 'X_JOB_KEY_BUSY']);
    expect(await statusOf(first.runId)).toBe('running');

    await answerPrompt.as(writer, { orgId: ORG, runId: first.runId, prompt: 1, answer: '482913' });
    const outcomes = (await draining).executions.map((run) => [run.jobId, run.outcome]);
    expect(outcomes).toContainEqual([first.jobId, 'completed']);
    expect(outcomes).toContainEqual([second.jobId, 'refused']);
    expect((await rowOf(jobDriver(), second.jobId)).lastError).toContain('X_JOB_KEY_BUSY');
    const kinds = (await connectedAs(() => repo.eventsOf(first.runId, 50))).map((e) => e.kind);
    expect(kinds).toEqual(['prompt', 'answered', 'navigated', 'extracted', 'done', 'usage']);
    expect(await statusOf(first.runId)).toBe('done');
  });

  test('a different connection runs beside it', async ({ runJobs }) => {
    const one = await connect();
    const two = await connect();
    const first = await startRun.as(writer, { orgId: ORG, connectionId: one.id });
    const second = await startRun.as(writer, { orgId: ORG, connectionId: two.id });

    const draining = runJobs.drain();
    await until(() => connectedAs(() => repo.promptEvent(first.runId, 1)));
    await until(() => connectedAs(() => repo.promptEvent(second.runId, 1)));
    for (const run of [first, second]) {
      await answerPrompt.as(writer, { orgId: ORG, runId: run.runId, prompt: 1, answer: '1' });
    }
    const outcomes = (await draining).executions.map((execution) => execution.outcome);
    expect(outcomes).toEqual(['completed', 'completed']);
  });

  test('cancelling a waiting run stops it at its prompt and records the failure', async ({
    runJobs,
    clock,
  }) => {
    const connection = await connect();
    const run = await startRun.as(writer, { orgId: ORG, connectionId: connection.id });
    const draining = runJobs.drain();
    await until(() => connectedAs(() => repo.promptEvent(run.runId, 1)));

    expect(await cancelRun.as(writer, { orgId: ORG, runId: run.runId })).toEqual({
      runId: run.runId,
    });
    expect((await rowOf(jobDriver(), run.jobId)).state).toBe('cancelled');
    // The held run hears its cancel at its next lease renewal, and `runJobs` renews on this clock.
    clock.advance(1);
    await draining;
    // The cancel said so where the console reads it — once: the worker's own settle matched
    // nothing, so the job was not told a second ending.
    const events = await connectedAs(() => repo.eventsOf(run.runId, 50));
    expect(events.map((event) => [event.kind, event.message])).toEqual([
      ['prompt', 'one-time code'],
      ['failed', 'X_ABORTED'],
    ]);
    expect(await statusOf(run.runId)).toBe('failed');
    // Cancelling an ended run changes nothing, and writes no second ending.
    await cancelRun.as(writer, { orgId: ORG, runId: run.runId });
    expect(await connectedAs(() => repo.eventsOf(run.runId, 50))).toHaveLength(2);
  });

  test('starting a run on a connection the org does not have is refused by name', async () => {
    const absent = '00000000-0000-4000-8000-0000000000ff';
    const refused = await startRun
      .as(writer, { orgId: ORG, connectionId: absent })
      .catch((error: unknown) => error);
    expect(refused).toBeUltimateError('X_CONNECTION_NOT_FOUND');
  });

  test('an answer or a cancel for a run in another org is forbidden', async ({ runJobs }) => {
    const connection = await connect();
    const run = await startRun.as(writer, { orgId: ORG, connectionId: connection.id });
    const draining = runJobs.drain();
    await until(() => connectedAs(() => repo.promptEvent(run.runId, 1)));

    const theirs = { orgId: OTHER_ORG, runId: run.runId, prompt: 1, answer: '1' };
    await expect(answerPrompt.as(outsider, theirs)).rejects.toBeUltimateError('X_FORBIDDEN');
    const cancel = { orgId: OTHER_ORG, runId: run.runId };
    await expect(cancelRun.as(outsider, cancel)).rejects.toBeUltimateError('X_FORBIDDEN');
    // A prompt the run never asked is no row at all, so the same rule denies it.
    const unasked = { orgId: ORG, runId: run.runId, prompt: 7, answer: '1' };
    await expect(answerPrompt.as(writer, unasked)).rejects.toBeUltimateError('X_FORBIDDEN');
    // And a run nobody started is no row either.
    const nobodys = { orgId: ORG, runId: '00000000-0000-4000-8000-0000000000fe' };
    await expect(cancelRun.as(writer, nobodys)).rejects.toBeUltimateError('X_FORBIDDEN');

    await answerPrompt.as(writer, { orgId: ORG, runId: run.runId, prompt: 1, answer: '1' });
    await draining;
  });
});

/** A read as the org's own member: the handle scopes every statement to the acting actor. */
function connectedAs<T>(read: () => Promise<T>): Promise<T> {
  return runWithContext(ctxOf({ actor: userActor({ id: 'writer', orgId: ORG }) }), read);
}
