/**
 * contract — a machine caller on the bearer mount. The mount is read from the app's own
 * declaration (`defineApi({ http: { mounts } })`) and built the way the boot builds it: the SAME
 * route the browser's `/api` call reaches, under `/v1`, behind `Authorization: Bearer`. No second
 * API, and no second policy.
 *
 * Registration happens in `scripts/test-setup.ts`, the preload; this file never imports `api/`.
 */

import { driver } from '@postly/db';
import { derivePath } from '@ultimat3/action';
import { apiMountRoutes } from '@ultimat3/cli';
import { defineHttpConfig, httpServer, mountedPath } from '@ultimat3/http';
import { jobDriver, memoryJobDriver, resetJobDriver, setJobDriver } from '@ultimat3/jobs';
import { testActor } from '@ultimat3/policy';
import { afterEach, beforeEach, expect, test } from '@ultimat3/testing';
import { connectSite } from './actions/connect-site';
import { issueRunKey } from './actions/issue-run-key';
import { revokeRunKey } from './actions/revoke-run-key';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a9';
const grants = ['run:read', 'run:write', 'run:key'];
const admin = testActor('admin', { orgId: ORG, permissions: grants }).actor;
const otherAdmin = testActor('other-admin', { orgId: OTHER_ORG, permissions: grants }).actor;

const previous = jobDriver();

beforeEach(() => {
  setJobDriver(memoryJobDriver());
});

afterEach(() => {
  if (previous === undefined) resetJobDriver();
  else setJobDriver(previous);
  driver.reset?.();
});

/** The mount the app declared, built by the function both boots build it with. */
const mountedServer = () =>
  httpServer({
    routes: apiMountRoutes(),
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    // A session, to prove the mount ignores it: only the bearer token authenticates here.
    hooks: { authenticate: () => admin },
  });

const START = mountedPath('/v1', derivePath('startRun').path);

const post = (path: string, body: unknown, token?: string): Request =>
  new Request(`http://dev.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

test('a bearer call with an issued key starts a run', async () => {
  const connection = await connectSite.as(admin, { orgId: ORG, label: 'Ledger', credential: 'x' });
  const issued = await issueRunKey.as(admin, { orgId: ORG });
  const server = mountedServer();

  const response = await server.fetch(
    post(START, { orgId: ORG, connectionId: connection.id }, issued.key),
  );

  expect(response.status).toBe(200);
  const started = (await response.json()) as { readonly runId: string; readonly jobId: string };
  // The run is on the queue, enqueued for the key's org.
  const row = await jobDriver()?.introspect?.job(started.jobId);
  expect(row?.name).toBe('runs.sync');
  expect(row?.runId).toBe(started.runId);
  expect(row?.tenantId).toBe(ORG);
});

test('a revoked key is refused: 401, and nothing is enqueued', async () => {
  const connection = await connectSite.as(admin, { orgId: ORG, label: 'Ledger', credential: 'x' });
  const issued = await issueRunKey.as(admin, { orgId: ORG });
  await revokeRunKey.as(admin, { orgId: ORG, keyId: issued.id });
  const server = mountedServer();

  const response = await server.fetch(
    post(START, { orgId: ORG, connectionId: connection.id }, issued.key),
  );

  expect(response.status).toBe(401);
  expect(response.headers.get('www-authenticate')).toContain('Bearer');
  expect(await jobDriver()?.introspect?.list({})).toEqual([]);
});

test('no token is 401 even with a session: a cookie authenticates nothing on the mount', async () => {
  const response = await mountedServer().fetch(post(START, { orgId: ORG, connectionId: ORG }));
  expect(response.status).toBe(401);
});

test('a key acts in the org it was issued in, and in no other', async () => {
  const connection = await connectSite.as(admin, { orgId: ORG, label: 'Ledger', credential: 'x' });
  const theirs = await issueRunKey.as(otherAdmin, { orgId: OTHER_ORG });

  const response = await mountedServer().fetch(
    post(START, { orgId: ORG, connectionId: connection.id }, theirs.key),
  );

  expect(response.status).toBe(403);
  expect(await jobDriver()?.introspect?.list({})).toEqual([]);
});

test('a primitive outside the mount’s cut is 404 there, like an unknown path', async () => {
  const issued = await issueRunKey.as(admin, { orgId: ORG });
  // `issueRunKey` is projected under /api and named by no scope: a key cannot mint keys.
  const path = mountedPath('/v1', derivePath('issueRunKey').path);
  const response = await mountedServer().fetch(post(path, { orgId: ORG }, issued.key));
  expect(response.status).toBe(404);
});
