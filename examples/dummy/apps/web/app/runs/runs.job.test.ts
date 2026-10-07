/**
 * job — one sync of one connection, end to end on the fixture driver and through `runJobs`' real
 * worker: the events it writes, the prompt it waits on, what it records having used, how a run
 * that could not sign in is recorded, and what it leaves in the session bucket.
 */

import { driver } from '@postly/db';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { jobDriver } from '@ultimat3/jobs';
import { answerPrompt, noWaitClock, resetScrapeClock, setScrapeClock } from '@ultimat3/scraping';
import type { MemoryStorageDriver } from '@ultimat3/storage';
import { defineStorage, memoryStorageDriver, resetStorage } from '@ultimat3/storage';
import { afterEach, beforeEach, expect, type JobRunTrace, jobTest } from '@ultimat3/testing';
import { PROMPT_LABEL, syncConnection } from './jobs';
import * as repo from './repo';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const CREDENTIAL = 'correct horse battery staple';
/** A proxy URL with its account in it: what must never reach the queue row. */
const EXIT = 'http://session-41:hunter2hunter2@exit-7.example:8080';

/** What a request is to the handle: an actor, whose org every read and write runs under. */
const inOrg = <T>(run: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'member', orgId: ORG }) }), run);

/** Macrotasks until `ready` answers: the run is in flight in this process, on its own awaits. */
const until = async <T>(ready: () => Promise<T | null>): Promise<T> => {
  for (let tick = 0; tick < 200; tick += 1) {
    const found = await ready();
    if (found !== null) return found;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return expect.unreachable('the run never reached the state the test waits for');
};

let sessions: MemoryStorageDriver;

beforeEach(() => {
  sessions = memoryStorageDriver();
  defineStorage({ disks: { sessions } });
  // No wall-clock wait in this file: a poll is one turn of the event loop.
  setScrapeClock(noWaitClock);
});

afterEach(() => {
  resetScrapeClock();
  resetStorage();
  driver.reset?.();
});

const connect = (exit: string | null = null) =>
  inOrg(() => repo.insertConnection({ orgId: ORG, label: 'Ledger', credential: CREDENTIAL, exit }));

/** What `startRun` does: the job, and the run's row beside it under the ids the queue chose. */
const start = async (connectionId: string) => {
  const queued = await syncConnection.enqueue(
    { connectionId, orgId: ORG, requestId: crypto.randomUUID() },
    { tenantId: ORG },
  );
  await inOrg(() =>
    repo.insertRun({ id: queued.runId, orgId: ORG, connectionId, jobId: queued.id }),
  );
  return queued;
};

const kindsOf = async (runId: string) =>
  (await inOrg(() => repo.eventsOf(runId, 50))).map((event) => event.kind);

const outcomesOf = async (draining: Promise<JobRunTrace>) =>
  (await draining).executions.map((run) => run.outcome);

jobTest('a run with nobody answering stays on its prompt, at seq 1', async ({ runJobs }) => {
  const connection = await connect();
  const { runId } = await start(connection.id);
  const running = runJobs.drain();

  const asked = await until(() => inOrg(() => repo.promptEvent(runId, 1)));
  // From 1, never 0: a reader asking for `seq > 0` loses an event numbered 0.
  expect(asked.seq).toBe(1);
  expect(asked.message).toBe(PROMPT_LABEL);
  expect(await kindsOf(runId)).toEqual(['prompt']);

  await answerPrompt({ runId, index: 1, answer: '482913' });
  expect(await outcomesOf(running)).toEqual(['completed']);
});

jobTest(
  'the run writes events 1..n in order, resumes on the answer and records what it used',
  async ({ runJobs }) => {
    const connection = await connect(EXIT);
    const { id, runId } = await start(connection.id);
    const running = runJobs.drain();

    await until(() => inOrg(() => repo.promptEvent(runId, 1)));
    await answerPrompt({ runId, index: 1, answer: '482913' });
    expect(await outcomesOf(running)).toEqual(['completed']);

    const events = await inOrg(() => repo.eventsOf(runId, 50));
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events.map((event) => event.kind)).toEqual([
      'prompt',
      'answered',
      'navigated',
      'extracted',
      'done',
      'usage',
    ]);
    expect(events.at(-2)?.message).toBe('2');

    // The report reached the app from a WORKER: `onSettled` was handed it and recorded it.
    const usage = events.at(-1)?.usage;
    expect(usage).toMatchObject({ navigations: 2, httpRequests: 1, promptsAnswered: 1 });
    expect(usage?.bytesIn).toBeGreaterThan(0);
    expect(Number.isInteger(usage?.browserMs)).toBe(true);

    // The exit was looked up in the worker, OPENED from its sealed column: the stored job row
    // carries ids and nothing else.
    const row = JSON.stringify(await jobDriver()?.introspect?.job(id));
    expect(row).not.toContain('hunter2hunter2');
    expect(row).not.toContain('exit-7.example');

    // The session it logged into is stored, and nothing in the bucket is readable.
    const stored = [...sessions.objects().values()].map((bytes) => new TextDecoder().decode(bytes));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain('"sealed":"x1.');
    expect(stored[0]).not.toContain('ledger.example');
    expect(stored[0]).not.toContain(CREDENTIAL);
  },
);

jobTest(
  'a second run of the connection reuses the stored session and asks nothing',
  async ({ runJobs }) => {
    const connection = await connect();
    const first = await start(connection.id);
    const running = runJobs.drain();
    await until(() => inOrg(() => repo.promptEvent(first.runId, 1)));
    await answerPrompt({ runId: first.runId, index: 1, answer: '482913' });
    await running;

    const again = await start(connection.id);
    // The trace is cumulative: the first run, then this one.
    expect(await outcomesOf(runJobs.drain())).toEqual(['completed', 'completed']);
    expect(await kindsOf(again.runId)).toEqual(['navigated', 'extracted', 'done', 'usage']);
    const used = (await inOrg(() => repo.eventsOf(again.runId, 50))).at(-1)?.usage;
    // Nobody was asked: the stored session signed it in.
    expect(used?.promptsAnswered).toBe(0);
  },
);

jobTest(
  'a connection that is gone fails the run, and the failure is on the record',
  async ({ runJobs }) => {
    const { id, runId } = await start('00000000-0000-4000-8000-0000000000ff');

    expect(await outcomesOf(runJobs.drain())).toEqual(['dead-lettered']);

    // A login failure is outside the body and outside any prompt: only the settle hook sees it,
    // and what the attempt used before it failed is recorded beside it.
    const events = await inOrg(() => repo.eventsOf(runId, 50));
    expect(events.map((event) => [event.seq, event.kind, event.message])).toEqual([
      [1, 'failed', 'X_CONNECTION_NOT_FOUND'],
      [2, 'usage', ''],
    ]);
    expect(events[1]?.usage?.navigations).toBe(0);
    expect((await jobDriver()?.introspect?.job(id))?.lastError).toContain('X_CONNECTION_NOT_FOUND');
  },
);
