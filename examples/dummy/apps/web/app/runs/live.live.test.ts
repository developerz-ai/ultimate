/**
 * live — a run's events through a whole `sync` node in this process: the snapshot a subscriber
 * gets, the patch each event the job writes arrives as, and who is refused.
 *
 * `repo.eventsOf` names no org: the sync node reads a live query's source FOR its subscriber's
 * tenant, in a context that carries it, exactly as a request does. Read with no context it
 * answered `X_TENANCY_UNSCOPED` to every subscriber — while the unit suite, which calls the query
 * `.as(actor)`, passed. A real browser found it; this is the suite that holds it.
 */

import type { RunEvent } from '@postly/db';
import { createContext, runWithContext } from '@ultimat3/core';
import { expect, test } from '@ultimat3/testing';
import { liveRunEvents } from './live';
import * as repo from './repo';

const RUN = '00000000-0000-4000-8000-0000000000b1';
const CONNECTION = '00000000-0000-4000-8000-0000000000d1';

/** The row `startRun` writes before a run has any event: `run_events.run_id` references it. */
const started = (orgId: string, runId = RUN) =>
  repo.insertRun({ id: runId, orgId, connectionId: CONNECTION, jobId: `job-${runId}` });

test('a subscriber’s snapshot is the run’s events so far, in seq order', async ({
  seed,
  actorFor,
  subscribe,
}) => {
  const { ada, acme } = await seed('dev').pick({ ada: 'member:ada', acme: 'org:acme' });
  const asAda = <T>(run: () => Promise<T>): Promise<T> =>
    runWithContext(createContext({ actor: actorFor(ada) }), run);
  const event = { orgId: acme.id, runId: RUN, message: 'one-time code' };
  await asAda(() => started(acme.id));
  await asAda(() => repo.appendEvent({ ...event, kind: 'prompt', prompt: 1 }));
  await asAda(() => repo.appendEvent({ ...event, kind: 'answered' }));

  const events = await subscribe<RunEvent>(
    liveRunEvents,
    { orgId: acme.id, runId: RUN },
    actorFor(ada),
  );

  expect(events.rows().map((row) => [row.seq, row.kind])).toEqual([
    [1, 'prompt'],
    [2, 'answered'],
  ]);
  expect(events.snapshots()).toBe(1);
});

test('an event the job writes arrives as one insert, never a re-read', async ({
  seed,
  actorFor,
  subscribe,
}) => {
  const { ada, acme } = await seed('dev').pick({ ada: 'member:ada', acme: 'org:acme' });
  const asAda = <T>(run: () => Promise<T>): Promise<T> =>
    runWithContext(createContext({ actor: actorFor(ada) }), run);
  const events = await subscribe<RunEvent>(
    liveRunEvents,
    { orgId: acme.id, runId: RUN },
    actorFor(ada),
  );
  expect(events.rows()).toEqual([]);

  // The run's row moves with every phase event: a write to ANOTHER table, which must not cost
  // this window the event itself.
  await asAda(() => started(acme.id));
  const event = { orgId: acme.id, runId: RUN, message: '' };
  await asAda(() => repo.appendEvent({ ...event, kind: 'navigated' }));
  await events.settled();

  expect(events.snapshots()).toBe(1);
  expect(events.patches()).toMatchObject([{ op: 'insert', row: { seq: 1, kind: 'navigated' } }]);
  expect(events.rows().map((row) => row.seq)).toEqual([1]);
});

test('an event of another run is not this subscriber’s', async ({ seed, actorFor, subscribe }) => {
  const { ada, acme } = await seed('dev').pick({ ada: 'member:ada', acme: 'org:acme' });
  const asAda = <T>(run: () => Promise<T>): Promise<T> =>
    runWithContext(createContext({ actor: actorFor(ada) }), run);
  const events = await subscribe<RunEvent>(
    liveRunEvents,
    { orgId: acme.id, runId: RUN },
    actorFor(ada),
  );

  const other = '00000000-0000-4000-8000-0000000000b2';
  await asAda(() => started(acme.id, other));
  await asAda(() =>
    repo.appendEvent({ orgId: acme.id, runId: other, kind: 'navigated', message: '' }),
  );
  await events.settled();

  expect(events.rows()).toEqual([]);
  expect(events.patches()).toEqual([]);
});

test('a member of another org cannot subscribe to the run', async ({
  seed,
  actorFor,
  subscribe,
}) => {
  const { mara, acme } = await seed('dev').pick({ mara: 'member:mara', acme: 'org:acme' });
  await expect(
    subscribe<RunEvent>(liveRunEvents, { orgId: acme.id, runId: RUN }, actorFor(mara)),
  ).rejects.toBeUltimateError('X_FORBIDDEN');
});

test('two orgs never share a window: each sees its own events, in snapshot and in patch', async ({
  seed,
  actorFor,
  subscribe,
}) => {
  const { ada, acme, mara, tinta } = await seed('dev').pick({
    ada: 'member:ada',
    acme: 'org:acme',
    mara: 'member:mara',
    tinta: 'org:tinta',
  });
  const as = <T>(member: Parameters<typeof actorFor>[0], run: () => Promise<T>): Promise<T> =>
    runWithContext(createContext({ actor: actorFor(member) }), run);
  // One run in each org, each with its own id: a run's row is keyed by it, across tenants.
  const theirs = '00000000-0000-4000-8000-0000000000b9';
  await as(ada, () => started(acme.id));
  await as(mara, () => started(tinta.id, theirs));
  const event = { kind: 'navigated' as const };
  await as(ada, () => repo.appendEvent({ ...event, runId: RUN, orgId: acme.id, message: 'acme' }));
  await as(mara, () =>
    repo.appendEvent({ ...event, runId: theirs, orgId: tinta.id, message: 'tinta' }),
  );

  const acmeEvents = await subscribe<RunEvent>(
    liveRunEvents,
    { orgId: acme.id, runId: RUN },
    actorFor(ada),
  );
  const tintaEvents = await subscribe<RunEvent>(
    liveRunEvents,
    { orgId: tinta.id, runId: theirs },
    actorFor(mara),
  );
  expect(acmeEvents.rows().map((row) => row.message)).toEqual(['acme']);
  expect(tintaEvents.rows().map((row) => row.message)).toEqual(['tinta']);

  await as(ada, () =>
    repo.appendEvent({ ...event, runId: RUN, orgId: acme.id, message: 'acme again' }),
  );
  await acmeEvents.settled();
  await tintaEvents.settled();

  expect(acmeEvents.rows().map((row) => row.message)).toEqual(['acme', 'acme again']);
  expect(tintaEvents.rows().map((row) => row.message)).toEqual(['tinta']);
  expect(tintaEvents.patches()).toEqual([]);
});
