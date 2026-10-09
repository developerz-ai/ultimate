// The run actions' declared shapes, the inputs they refuse and the branches the queue-driven
// tests in `runs.test.ts` do not reach: connecting, the key an admin issues and revokes, and what
// each says when there is no queue to ask.
import { driver } from '@postly/db';
import { ctxOf, runWithContext } from '@ultimat3/core';
import { jobDriver, memoryJobDriver, resetJobDriver, setJobDriver } from '@ultimat3/jobs';
import { testActor } from '@ultimat3/policy';
import { afterEach, expect, unitTest } from '@ultimat3/testing';
import { answerPrompt } from './actions/answer-prompt';
import { cancelRun } from './actions/cancel-run';
import { connectSite } from './actions/connect-site';
import { issueRunKey } from './actions/issue-run-key';
import { revokeRunKey } from './actions/revoke-run-key';
import { startRun } from './actions/start-run';
import { resolveRunKey } from './keys';
import * as repo from './repo';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a9';
const RUN = '00000000-0000-4000-8000-0000000000b1';

const grants = ['run:read', 'run:write', 'run:key'];
const admin = testActor('admin', { orgId: ORG, permissions: grants }).actor;
const writer = testActor('writer', { orgId: ORG, permissions: ['run:read', 'run:write'] }).actor;
const elsewhere = testActor('elsewhere', { orgId: OTHER_ORG, permissions: grants }).actor;

const previous = jobDriver();

afterEach(() => {
  if (previous === undefined) resetJobDriver();
  else setJobDriver(previous);
  driver.reset?.();
});

unitTest('each command is a declared action under its own name', () => {
  const declared = { connectSite, startRun, answerPrompt, cancelRun, issueRunKey, revokeRunKey };
  for (const [name, target] of Object.entries(declared)) {
    expect(target.kind).toBe('action');
    expect(target.named(name).describe().name).toBe(name);
  }
});

unitTest('the three run commands are MCP tools, and the two that carry a secret are not', () => {
  expect(startRun.mcp?.expose).toBe(true);
  expect(answerPrompt.mcp?.expose).toBe(true);
  expect(cancelRun.mcp?.expose).toBe(true);
  // A credential in, a key out: neither belongs in an agent's transcript.
  expect(connectSite.mcp).toBeUndefined();
  expect(issueRunKey.mcp).toBeUndefined();
});

unitTest('each input refuses what the handler could not act on', async () => {
  await expect(startRun.input).toAcceptInput({ orgId: ORG, connectionId: RUN });
  await expect(startRun.input).toRejectInput({ orgId: ORG, connectionId: 'ledger' });
  const answer = { orgId: ORG, runId: RUN, prompt: 1, answer: '482913' };
  await expect(answerPrompt.input).toAcceptInput(answer);
  await expect(answerPrompt.input).toRejectInput({ ...answer, prompt: 0 });
  await expect(answerPrompt.input).toRejectInput({ ...answer, answer: '' });
  await expect(answerPrompt.input).toRejectInput({ ...answer, answer: '1'.repeat(65) });
  await expect(cancelRun.input).toAcceptInput({ orgId: ORG, runId: RUN });
  await expect(cancelRun.input).toRejectInput({ orgId: ORG, runId: 'job-1' });
});

unitTest('connecting answers the view: an id and a label, never the credential', async () => {
  const input = { orgId: ORG, label: 'Ledger', credential: 'correct horse battery staple' };
  const made = await connectSite.as(writer, input);
  expect(made.label).toBe('Ledger');
  expect(JSON.stringify(made)).not.toContain('correct horse');
  expect(made).not.toHaveProperty('orgId');
});

unitTest('a started run is queued with ids: the exit stays on the connection row', async () => {
  const exit = 'http://session-41:hunter2hunter2@exit-7.example:8080';
  const input = { orgId: ORG, label: 'Ledger', credential: 'hunter2-hunter2', exit };
  const made = await connectSite.as(writer, input);
  setJobDriver(memoryJobDriver());
  const run = await startRun.as(writer, { orgId: ORG, connectionId: made.id });
  const row = await jobDriver()?.introspect?.job(run.jobId);
  // Both ids name the queue row, on whichever path the enqueue took.
  expect(row?.runId).toBe(run.runId);
  expect(row?.input).toMatchObject({ connectionId: made.id, orgId: ORG });
  // A proxy URL carries its account: the worker looks it up, the payload never holds it.
  expect(JSON.stringify(row)).not.toContain('hunter2hunter2');
});

unitTest(
  'an admin issues a key for their own org; the key resolves to that org’s agent',
  async () => {
    const issued = await issueRunKey.as(admin, { orgId: ORG });
    expect(issued.key.startsWith(`${issued.prefix}_`)).toBe(true);
    const caller = await resolveRunKey(issued.key);
    expect(caller?.actor.orgId).toBe(ORG);
    expect([...(caller?.scopes ?? [])].sort()).toEqual(['run:read', 'run:write']);
  },
);

unitTest('a member without the grant cannot issue a key', async () => {
  await expect(issueRunKey.as(writer, { orgId: ORG })).rejects.toBeUltimateError('X_FORBIDDEN');
});

unitTest('a revoked key resolves to nobody, and revoking it twice changes nothing', async () => {
  const issued = await issueRunKey.as(admin, { orgId: ORG });
  expect(await revokeRunKey.as(admin, { orgId: ORG, keyId: issued.id })).toEqual({ revoked: true });
  expect(await resolveRunKey(issued.key)).toBeNull();
  expect(await revokeRunKey.as(admin, { orgId: ORG, keyId: issued.id })).toEqual({
    revoked: false,
  });
});

unitTest('a key from another org, or one nobody issued, cannot be revoked', async () => {
  const issued = await issueRunKey.as(admin, { orgId: ORG });
  const theirs = { orgId: OTHER_ORG, keyId: issued.id };
  await expect(revokeRunKey.as(elsewhere, theirs)).rejects.toBeUltimateError('X_FORBIDDEN');
  const unknown = { orgId: ORG, keyId: 'nobody-issued-this' };
  await expect(revokeRunKey.as(admin, unknown)).rejects.toBeUltimateError('X_FORBIDDEN');
  expect(await resolveRunKey(issued.key)).not.toBeNull();
});

unitTest('a cancel names its missing queue instead of failing on undefined', async () => {
  const made = await connectSite.as(writer, { orgId: ORG, label: 'Ledger', credential: 'x' });
  setJobDriver(memoryJobDriver());
  const run = await startRun.as(writer, { orgId: ORG, connectionId: made.id });
  resetJobDriver();
  const refused = await cancelRun
    .as(writer, { orgId: ORG, runId: run.runId })
    .catch((error: unknown) => error);
  expect(refused).toBeUltimateError('X_RUN_QUEUE_UNAVAILABLE');
});

unitTest('a started run has its own row, queued, naming the job that runs it', async () => {
  const made = await connectSite.as(writer, { orgId: ORG, label: 'Ledger', credential: 'x' });
  setJobDriver(memoryJobDriver());
  const run = await startRun.as(writer, { orgId: ORG, connectionId: made.id });
  const row = await runWithContext(ctxOf({ actor: writer }), () => repo.runById(run.runId));
  expect(row).toMatchObject({
    orgId: ORG,
    connectionId: made.id,
    jobId: run.jobId,
    status: 'queued',
    code: null,
  });
});

unitTest('a run nobody started, or another org’s, cannot be cancelled', async () => {
  setJobDriver(memoryJobDriver());
  const made = await connectSite.as(writer, { orgId: ORG, label: 'Ledger', credential: 'x' });
  const run = await startRun.as(writer, { orgId: ORG, connectionId: made.id });
  const theirs = { orgId: OTHER_ORG, runId: run.runId };
  await expect(cancelRun.as(elsewhere, theirs)).rejects.toBeUltimateError('X_FORBIDDEN');
  const absent = { orgId: ORG, runId: '00000000-0000-4000-8000-0000000000fe' };
  await expect(cancelRun.as(writer, absent)).rejects.toBeUltimateError('X_FORBIDDEN');
});
