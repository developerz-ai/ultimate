// The runs repo against the in-memory driver: whose rows a call reaches, what happens to the
// sealed column on the way in and out, and how an event gets its number.
import { driver } from '@postly/db';
import { createContext, runWithContext, userActor } from '@ultimat3/core';
import { afterEach, expect, unitTest } from '@ultimat3/testing';
import * as repo from './repo';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a9';
const RUN = '00000000-0000-4000-8000-0000000000b1';
const OTHER_RUN = '00000000-0000-4000-8000-0000000000b2';
const CREDENTIAL = 'correct horse battery staple';
const CONNECTION = '00000000-0000-4000-8000-0000000000d1';

/** The row `startRun` writes before a run has any event: `run_events.run_id` references it. */
const started = (runId = RUN) =>
  inOrg(ORG, () =>
    repo.insertRun({ id: runId, orgId: ORG, connectionId: CONNECTION, jobId: `job-${runId}` }),
  );

/** What a request is to the handle: an actor, whose org every read and write runs under. */
const inOrg = <T>(org: string, run: () => Promise<T>): Promise<T> =>
  runWithContext(createContext({ actor: userActor({ id: 'member', orgId: org }) }), run);

const ledger = { orgId: ORG, label: 'Ledger', credential: CREDENTIAL, exit: null };

// One store per process: without this, one test's rows are the next test's fixtures.
afterEach(() => {
  driver.reset?.();
});

unitTest('a connection is stored and read back whole, credential included', async () => {
  const stored = await inOrg(ORG, () => repo.insertConnection(ledger));
  expect(stored.id).toHaveLength(36);
  const read = await inOrg(ORG, () => repo.connectionById(stored.id));
  // `toEqualRow`, never `toEqual`: the sealed column is not enumerable, so `toEqual` would call
  // two rows equal that hold different secrets.
  expect(read).toEqualRow(stored);
  expect(read?.credential).toBe(CREDENTIAL);
});

unitTest('the credential is on the row by name and in nothing that walks it', async () => {
  const stored = await inOrg(ORG, () => repo.insertConnection(ledger));
  expect(JSON.stringify(stored)).not.toContain(CREDENTIAL);
  expect(Object.keys(stored)).not.toContain('credential');
  expect({ ...stored }).not.toHaveProperty('credential');
});

unitTest('a connection id nothing holds reads null', async () => {
  const absent = '00000000-0000-4000-8000-0000000000ff';
  expect(await inOrg(ORG, () => repo.connectionById(absent))).toBeNull();
});

unitTest('connections list newest first, bounded, and only the actor’s own', async () => {
  for (const label of ['first', 'second', 'third']) {
    await inOrg(ORG, () => repo.insertConnection({ ...ledger, label }));
  }
  expect(await inOrg(ORG, () => repo.listConnections(2))).toHaveLength(2);
  expect(await inOrg(ORG, () => repo.listConnections(50))).toHaveLength(3);
  // No org is passed and none can be: the acting actor's scopes the read.
  expect(await inOrg(OTHER_ORG, () => repo.listConnections(50))).toEqual([]);
});

unitTest('a connection naming another org is refused, never stored under the actor’s', async () => {
  const refused = await inOrg(OTHER_ORG, () => repo.insertConnection(ledger)).catch(
    (error: unknown) => error,
  );
  expect(refused).toBeUltimateError('X_TENANCY_ACTOR_MISMATCH');
});

unitTest('the first event of a run is seq 1, and each next one is the last plus one', async () => {
  await started();
  const event = { orgId: ORG, runId: RUN, message: 'one-time code' };
  const first = await inOrg(ORG, () => repo.appendEvent({ ...event, kind: 'prompt', prompt: 1 }));
  const second = await inOrg(ORG, () => repo.appendEvent({ ...event, kind: 'answered' }));
  expect(first.seq).toBe(1);
  expect(first.prompt).toBe(1);
  expect(second.seq).toBe(2);
  expect(second.prompt).toBeNull();
});

unitTest('each run numbers its own events', async () => {
  await started();
  await started(OTHER_RUN);
  const event = { orgId: ORG, kind: 'navigated' as const, message: '' };
  await inOrg(ORG, () => repo.appendEvent({ ...event, runId: RUN }));
  await inOrg(ORG, () => repo.appendEvent({ ...event, runId: RUN }));
  const other = await inOrg(ORG, () => repo.appendEvent({ ...event, runId: OTHER_RUN }));
  expect(other.seq).toBe(1);
  const seqs = (await inOrg(ORG, () => repo.eventsOf(RUN, 50))).map((row) => row.seq);
  expect(seqs).toEqual([1, 2]);
});

unitTest('a run’s events are read in seq order, bounded, and never by another org', async () => {
  await started();
  const event = { orgId: ORG, runId: RUN, kind: 'navigated' as const, message: '' };
  for (let n = 0; n < 3; n += 1) await inOrg(ORG, () => repo.appendEvent(event));
  expect((await inOrg(ORG, () => repo.eventsOf(RUN, 2))).map((row) => row.seq)).toEqual([1, 2]);
  // The same run id, asked for by another org: its own rows, which are none.
  expect(await inOrg(OTHER_ORG, () => repo.eventsOf(RUN, 50))).toEqual([]);
});

unitTest('the prompt row is found by its index, and only while it is one', async () => {
  await started();
  const event = { orgId: ORG, runId: RUN, message: 'one-time code' };
  await inOrg(ORG, () => repo.appendEvent({ ...event, kind: 'prompt', prompt: 1 }));
  expect((await inOrg(ORG, () => repo.promptEvent(RUN, 1)))?.kind).toBe('prompt');
  expect(await inOrg(ORG, () => repo.promptEvent(RUN, 2))).toBeNull();
  expect(await inOrg(OTHER_ORG, () => repo.promptEvent(RUN, 1))).toBeNull();
});

unitTest('no read here names an org, so one with no actor around it is refused', async () => {
  // A script or a boot path. Every surface the framework serves — a request, a job, a live
  // subscriber's window — installs the actor these reads are scoped by.
  for (const read of [() => repo.promptEvent(RUN, 1), () => repo.eventsOf(RUN, 50)]) {
    expect(await read().catch((error: unknown) => error)).toBeUltimateError('X_TENANCY_UNSCOPED');
  }
});

unitTest('each phase event moves the run’s status; a usage event moves nothing', async () => {
  const run = await started();
  expect([run.status, run.code]).toEqual(['queued', null]);
  const statusAfter = async (kind: 'prompt' | 'done' | 'failed' | 'usage', message = '') => {
    await inOrg(ORG, () => repo.appendEvent({ orgId: ORG, runId: RUN, kind, message }));
    const row = await inOrg(ORG, () => repo.runById(RUN));
    return [row?.status, row?.code];
  };
  expect(await statusAfter('prompt')).toEqual(['running', null]);
  expect(await statusAfter('failed', 'X_SCRAPE_PROMPT_UNANSWERED')).toEqual([
    'failed',
    'X_SCRAPE_PROMPT_UNANSWERED',
  ]);
  expect(await statusAfter('usage')).toEqual(['failed', 'X_SCRAPE_PROMPT_UNANSWERED']);
  expect(await statusAfter('done', '2')).toEqual(['done', null]);
});

unitTest(
  'an event for a run that has no row is refused, as the foreign key refuses it',
  async () => {
    const orphan = { orgId: ORG, runId: OTHER_RUN, kind: 'navigated' as const, message: '' };
    const refused = await inOrg(ORG, () => repo.appendEvent(orphan)).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeUltimateError('X_NOT_FOUND');
    expect(await inOrg(ORG, () => repo.runById(OTHER_RUN))).toBeNull();
  },
);
