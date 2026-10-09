// The runs feature's reads, as a caller gets them: through the policy, the source and the repo,
// against the in-memory driver. The subscription itself is the live suite's and the e2e's.
import { driver } from '@postly/db';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { testActor } from '@ultimat3/policy';
import { sourceFor } from '@ultimat3/query';
import { afterEach, expect, unitTest } from '@ultimat3/testing';
import { liveRunEvents } from './live/live-run-events';
import { runConnections } from './queries/run-connections';
import * as repo from './repo';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a9';
const RUN = '00000000-0000-4000-8000-0000000000b1';
const CONNECTION = '00000000-0000-4000-8000-0000000000d1';

// Named here because every projection needs a stable name and this file does not boot the app.
const events = liveRunEvents.named('liveRunEvents');
const connections = runConnections.named('runConnections');

const member = testActor('member', { orgId: ORG, permissions: ['run:read'] }).actor;
const outsider = testActor('outsider', { orgId: OTHER_ORG, permissions: ['run:read'] }).actor;

const inOrg = <T>(run: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'member', orgId: ORG }) }), run);

afterEach(() => {
  driver.reset?.();
});

unitTest('liveRunEvents is a live query an agent may read, and never write through', () => {
  expect(events.kind).toBe('query');
  expect(events.isLive).toBe(true);
  // Offered to an agent through `@ultimat3/mcp`'s `toolFrom`, which projects a query as a
  // read (`mutates: false`) under this same policy; the query itself declares only the exposure.
  expect(events.mcp?.expose).toBe(true);
});

unitTest('a run’s events come back in seq order', async () => {
  const event = { orgId: ORG, runId: RUN, message: '' };
  await inOrg(() =>
    repo.insertRun({ id: RUN, orgId: ORG, connectionId: CONNECTION, jobId: 'job-1' }),
  );
  await inOrg(() => repo.appendEvent({ ...event, kind: 'prompt', prompt: 1 }));
  await inOrg(() => repo.appendEvent({ ...event, kind: 'answered' }));
  const rows = await events.as(member, { orgId: ORG, runId: RUN, limit: 50 });
  expect(rows.map((row) => [row.seq, row.kind])).toEqual([
    [1, 'prompt'],
    [2, 'answered'],
  ]);
});

unitTest('the read is bounded and totally ordered: seq, then id', async () => {
  const source = await sourceFor(
    events,
    { orgId: ORG, runId: RUN, limit: 50 },
    { actor: null, unenforced: 'this test asserts the SQL text; the policy is asserted below' },
  );
  const text = source.toSQL().sql.toLowerCase();
  expect(text).toContain('limit');
  const order = text.slice(text.lastIndexOf('order by'));
  expect(order.indexOf('seq')).toBeGreaterThan(-1);
  expect(order.indexOf('id')).toBeGreaterThan(order.indexOf('seq'));
});

unitTest('another org’s member is refused before a row is read', async () => {
  const input = { orgId: ORG, runId: RUN, limit: 50 };
  await expect(events.as(outsider, input)).rejects.toBeUltimateError('X_FORBIDDEN');
  await expect(connections.as(outsider, { orgId: ORG })).rejects.toBeUltimateError('X_FORBIDDEN');
});

unitTest('the connection list answers an id and a label, and no credential', async () => {
  const ledger = { orgId: ORG, label: 'Ledger', credential: 'correct horse battery', exit: null };
  await inOrg(() => repo.insertConnection(ledger));
  const rows = await connections.as(member, { orgId: ORG });
  expect(rows.map((row) => row.label)).toEqual(['Ledger']);
  expect(JSON.stringify(rows)).not.toContain('correct horse');
});

unitTest('an org with no connection reads empty', async () => {
  expect(await connections.as(member, { orgId: ORG })).toEqual([]);
});
