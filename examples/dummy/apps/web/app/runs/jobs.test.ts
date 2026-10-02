// The sync job's own seams, driven directly: what it is declared as, and what the prompt handler
// records around its wait. The whole run through a worker — its events, its ending, its usage —
// is `runs.test.ts` and the job suite.

import { driver } from '@postly/db';
import type { Ctx } from '@ultimat3/core';
import { createContext, runWithContext, userActor } from '@ultimat3/core';
import { answerPrompt, noWaitClock } from '@ultimat3/scraping';
import { afterEach, beforeEach, expect, unitTest } from '@ultimat3/testing';
import { askConsole, PROMPT_LABEL, recordedUsage, syncConnection } from './jobs';
import * as repo from './repo';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const RUN = '00000000-0000-4000-8000-0000000000b1';
const REQUEST = '00000000-0000-4000-8000-0000000000c1';
const INPUT = { connectionId: ORG, orgId: ORG, requestId: REQUEST };

const worker = (): Ctx => createContext({ actor: userActor({ id: 'worker', orgId: ORG }) });
const inOrg = <T>(run: () => Promise<T>): Promise<T> => runWithContext(worker(), run);

type Asked = Parameters<typeof askConsole>[0];

const request = (over: Partial<Asked> = {}): Asked => ({
  input: INPUT,
  label: PROMPT_LABEL,
  scrape: syncConnection.name,
  url: 'https://ledger.example/login',
  runId: RUN,
  index: 1,
  // Real deadlines, no waiting: each poll is one turn of the event loop.
  clock: noWaitClock,
  signal: undefined,
  keepAlive: () => Promise.resolve(),
  ...over,
});

/** Macrotasks until `ready` answers: the wait under test is in flight in this process. */
const until = async <T>(ready: () => Promise<T | null>): Promise<T> => {
  for (let tick = 0; tick < 200; tick += 1) {
    const found = await ready();
    if (found !== null) return found;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return expect.unreachable('the run never reached the state the test waits for');
};

// The row `startRun` writes before a run has any event: `run_events.run_id` references it.
beforeEach(async () => {
  await inOrg(() => repo.insertRun({ id: RUN, orgId: ORG, connectionId: ORG, jobId: 'job-1' }));
});

afterEach(() => {
  driver.reset?.();
});

unitTest('the sync is one job per start, keyed per connection, refusing a busy one', () => {
  expect(syncConnection.name).toBe('runs.sync');
  expect(syncConnection.idempotencyKeyFor(INPUT)).toBe(`runs.sync:${REQUEST}`);
  expect(syncConnection.tenantFor(INPUT)).toBe(ORG);
  expect(syncConnection.concurrencyKeyFor(INPUT)).toBe(ORG);
  expect(syncConnection.concurrency).toBe(1);
  expect(syncConnection.whenBusy).toBe('fail');
  // A session a person attends is not retried blind.
  expect(syncConnection.retry.attempts).toBe(1);
  // How every run ended is told to the job: the `failed` and `usage` events come from there.
  expect(syncConnection.declaresOnSettled).toBe(true);
});

unitTest('the usage a run records is the report’s counts, in whole milliseconds', () => {
  const report = {
    browserMs: 4200.6,
    navigations: 2,
    httpRequests: 1,
    bytesIn: 2048,
    promptsAnswered: 1,
    browserCost: { minor: 12, currency: 'USD' },
  };
  expect(recordedUsage(report)).toEqual({
    browserMs: 4201,
    navigations: 2,
    httpRequests: 1,
    bytesIn: 2048,
    promptsAnswered: 1,
  });
});

unitTest('the queue payload is ids: a credential or an exit in it is refused by the schema', () => {
  expect(syncConnection.parse(INPUT)).toEqual(INPUT);
  expect(Object.keys(syncConnection.parse({ ...INPUT, exit: 'http://u:p@exit:8080' }))).toEqual(
    Object.keys(INPUT),
  );
});

unitTest('the prompt handler records the question, then the answer it was given', async () => {
  const asking = inOrg(() => askConsole(request()));
  const asked = await until(() => inOrg(() => repo.promptEvent(RUN, 1)));
  expect(asked.seq).toBe(1);
  expect(asked.orgId).toBe(ORG);
  await answerPrompt({ runId: RUN, index: 1, answer: '482913' });

  expect(await asking).toBe('482913');
  const kinds = (await inOrg(() => repo.eventsOf(RUN, 50))).map((event) => event.kind);
  expect(kinds).toEqual(['prompt', 'answered']);
});

unitTest('a wait that is cancelled rejects, and writes no answer', async () => {
  const abort = new AbortController();
  const asking = inOrg(() => askConsole(request({ signal: abort.signal })));
  await until(() => inOrg(() => repo.promptEvent(RUN, 1)));
  abort.abort(new Error('cancelled by the test'));

  await expect(asking).rejects.toBeDefined();
  // The run's `failed` event is `onSettled`'s to write, once the queue has settled the row.
  const events = await inOrg(() => repo.eventsOf(RUN, 50));
  expect(events.map((event) => event.kind)).toEqual(['prompt']);
});
