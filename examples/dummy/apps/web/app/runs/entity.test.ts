// The three tables this feature reads and the shapes it puts on the wire: what is sealed, what a
// view may name, the rule about `seq` the database holds as well as the app, and what a run's row
// and its usage may hold.
import { connections, RUN_EVENT_KINDS, RUN_STATUSES, runEvents, runs } from '@postly/db';
import { relationsFor, sealedFields } from '@ultimat3/entity';
import { expect, unitTest } from '@ultimat3/testing';
import { CONNECTION_PAGE, ConnectInput, ConnectionView, RunKeyIssued, RunStarted } from './entity';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const RUN = '00000000-0000-4000-8000-0000000000b1';

const eventRow = (over: Partial<typeof runEvents.$row> = {}): typeof runEvents.$row => ({
  id: '00000000-0000-4000-8000-0000000000f1',
  orgId: ORG,
  runId: RUN,
  seq: 1,
  kind: 'prompt',
  at: new Date(0),
  message: 'one-time code',
  prompt: 1,
  usage: null,
  ...over,
});

unitTest('a connection is tenant-scoped, and its credential and its exit are sealed', () => {
  expect(connections.$name).toBe('connections');
  expect(connections.$tenantColumn).toBe('orgId');
  // The exit is a proxy URL that carries its account: as secret as the password.
  expect(sealedFields(connections).map((field) => field.property)).toEqual(['credential', 'exit']);
});

unitTest('the connection view names no credential, and no org', () => {
  expect(ConnectionView.$keys).toEqual(['id', 'label', 'createdAt']);
});

unitTest('a view that names the credential is refused where it is declared', () => {
  let refused: unknown;
  try {
    // Widened on purpose: the type already refuses the key, and this pins the runtime half.
    connections.$view(['id', 'credential'] as unknown as ['id']);
  } catch (error) {
    refused = error;
  }
  expect(refused).toBeUltimateError('X_ENTITY_SEALED_IN_VIEW');
});

unitTest('a run event numbers from 1: seq 0 is refused by the invariant', () => {
  expect(runEvents.$tenantColumn).toBe('orgId');
  expect(() => runEvents.$assert(eventRow())).not.toThrow();
  expect(() => runEvents.$assert(eventRow({ seq: 0 }))).toThrow();
  const rules = runEvents.$describe().invariants.map((rule) => rule.name);
  expect(rules).toContain('run_event_seq_from_one');
  expect(rules).toContain('run_event_seq_unique');
});

unitTest('a run event is one of the declared kinds', () => {
  expect(RUN_EVENT_KINDS).toEqual([
    'prompt',
    'answered',
    'navigated',
    'extracted',
    'done',
    'failed',
    'usage',
  ]);
  expect(() => runEvents.$parse({ ...eventRow(), kind: 'started' })).toThrow();
});

unitTest('a usage event holds whole, non-negative counts and nothing else', () => {
  const usage = {
    browserMs: 4200,
    navigations: 2,
    httpRequests: 1,
    bytesIn: 2048,
    promptsAnswered: 1,
  };
  expect(runEvents.$parse(eventRow({ kind: 'usage', usage })).usage).toEqual(usage);
  expect(() =>
    runEvents.$parse(eventRow({ kind: 'usage', usage: { ...usage, bytesIn: -1 } })),
  ).toThrow();
  expect(() =>
    runEvents.$parse(eventRow({ kind: 'usage', usage: { ...usage, navigations: 1.5 } })),
  ).toThrow();
});

unitTest('a run is tenant-scoped, in one of four statuses, and owns its events', () => {
  expect(runs.$tenantColumn).toBe('orgId');
  expect(RUN_STATUSES).toEqual(['queued', 'running', 'done', 'failed']);
  const row = {
    id: RUN,
    orgId: ORG,
    connectionId: '00000000-0000-4000-8000-0000000000d1',
    jobId: 'job-1',
    status: 'queued',
    code: null,
    startedAt: new Date(0),
  };
  expect(runs.$parse(row).status).toBe('queued');
  expect(() => runs.$parse({ ...row, status: 'cancelled' })).toThrow();
  // The relation the operator's view lists as a run's related rows: derived from the FK.
  expect(relationsFor('runs')['run_events']).toMatchObject({ kind: 'hasMany', to: 'run_events' });
});

unitTest('connecting takes a name and a credential, and refuses a blank one', async () => {
  await expect(ConnectInput).toAcceptInput({ orgId: ORG, label: 'Ledger', credential: 'hunter2' });
  const exit = 'http://exit-7.example:8080';
  await expect(ConnectInput).toAcceptInput({ orgId: ORG, label: 'Ledger', credential: 'x', exit });
  await expect(ConnectInput).toRejectInput({ orgId: ORG, label: '', credential: 'hunter2' });
  await expect(ConnectInput).toRejectInput({ orgId: ORG, label: 'Ledger', credential: '' });
  await expect(ConnectInput).toRejectInput({ label: 'Ledger', credential: 'hunter2' });
});

unitTest('the handles an action answers are the queue’s ids and a key shown once', async () => {
  await expect(RunStarted).toAcceptInput({ runId: RUN, jobId: 'job-1' });
  await expect(RunStarted).toRejectInput({ runId: 'not-a-uuid', jobId: 'job-1' });
  await expect(RunKeyIssued).toAcceptInput({ id: 'k1', prefix: 'ult_dev_k1', key: 'ult_dev_k1_s' });
  expect(CONNECTION_PAGE).toBe(50);
});
