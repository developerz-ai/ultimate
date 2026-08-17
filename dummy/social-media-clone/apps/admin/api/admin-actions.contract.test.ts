// contract — the toolbar's wire, driven over HTTP. The button `views.tsx` renders is a submit in a
// form posting at `ADMIN_ACTION_ROUTE`; this proves that URL is mounted, that pressing it reaches
// `invokeAdminAction` rather than nothing, and that the seeded operator's refusal is the DECISION
// refusing — audited, with the row untouched.
//
// A request and not a unit test, for the reason this app already learned once: the previous
// toolbar had a passing render test over buttons with no `onClick`, no form and no handler. Only a
// request proves a control acts.

import { resolve } from 'node:path';
import { seedDemo } from '@social-media-clone/db';
import { listActions, toRoute } from '@ultimat3/action';
import { appRoutes, devHooks, loadApp } from '@ultimat3/cli';
import type { Pipeline } from '@ultimat3/http';
import { createPipeline, createRouter, defineHttpConfig } from '@ultimat3/http';
import { beforeAll, contractTest, expect } from '@ultimat3/testing';
import { admin } from '../app/admin/admin';
import { usersAdminRepo } from '../app/admin/repo';
import { ADMIN_ACTION_ROUTE } from '../shared/action-route';

const ROOT = resolve(import.meta.dir, '../../..');
const ORIGIN = 'http://app.test';

let pipeline: Pipeline;
let cookie: string;
let maraId: string;

const call = (path: string, init?: RequestInit): Promise<Response> =>
  pipeline.handle(new Request(`${ORIGIN}${path}`, init), { role: 'web' });

/**
 * The form a browser posts: url-encoded, no JavaScript, `accept: text/html` — and `origin`, which
 * a browser attaches to every form POST and which the pipeline's CSRF stage requires of a
 * credentialed write. Omitting it here answered `X_CSRF_BLOCKED`, so the new door is covered by
 * the same protection every other write on this app has.
 */
const press = (form: Readonly<Record<string, string>>): Promise<Response> =>
  call(ADMIN_ACTION_ROUTE, {
    method: 'POST',
    headers: {
      cookie,
      origin: ORIGIN,
      accept: 'text/html',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
  });

beforeAll(async () => {
  await seedDemo();
  await loadApp(ROOT);
  pipeline = createPipeline({
    table: createRouter([...listActions().map(toRoute), ...appRoutes({ buildId: 'test' })]),
    hooks: devHooks(),
    config: defineHttpConfig({
      signInPath: '/signin',
      buildId: 'test',
      rateLimit: { scope: 'process' },
    }),
  });

  const signedIn = await call('/api/sessions/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle: 'admin', password: 'admin' }),
  });
  expect(signedIn.status).toBe(200);
  cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

  const [mara] = await usersAdminRepo.list({
    limit: 1,
    sort: { field: 'handle', direction: 'asc' },
    where: [{ field: 'handle', op: 'eq', value: 'mara' }],
  });
  maraId = String(mara?.id ?? '');
  // `loadApp` walks this app's whole module graph — ~2.7s alone, and the four contract files
  // that do it run while every other suite competes for the same cores, so the 5000ms bun
  // gives a hook is a coin flip rather than a budget. Booting the app IS the fixture here,
  // so the timeout is what moves. Raised across all four together: they share one cost, and
  // raising the one seen failing only relocates the failure to whichever shard the others
  // land in.
}, 30_000);

contractTest('the URL the form posts at is a route this app mounts', () => {
  expect(listActions().map((registered) => toRoute(registered).path)).toContain(ADMIN_ACTION_ROUTE);
});

// Failure first: a name nothing declares must be refused at the door, with a status that says
// whose mistake it was. It answered 500 — "the server broke" — before this file existed.
contractTest('a posted name no action declares is a 400, not a 500', async () => {
  const response = await press({ name: 'user.deport', id: maraId });
  expect(response.status).toBe(400);
});

contractTest(
  'the seeded operator is refused by the decision, not by a missing handler',
  async () => {
    expect(maraId).not.toBe('');
    const before = await usersAdminRepo.find(maraId);
    expect(before?.suspended).toBe(false);

    const response = await press({ name: 'user.suspend', id: maraId });

    // 403 and not 401: the operator IS signed in — that is what makes the refusal meaningful.
    expect(response.status).toBe(403);
    const body: unknown = await response.json();
    expect(JSON.stringify(body)).toContain('X_ADMIN_ACTION_REFUSED');

    // The denial is on the audit log: proof the request reached `invokeAdminAction` rather than a
    // route that answered without asking anything. The permission recorded is the FIRST of the
    // pair — `admin:write` is asked before `users:suspend`, so an actor who somehow held the
    // action's own grant alone still gets no further than this row.
    const denied = admin.audit
      .entries({ entity: 'users', limit: 20 })
      .filter((entry) => entry.operation === 'user.suspend' && entry.outcome === 'denied');
    expect(denied.length).toBeGreaterThan(0);
    expect(denied.some((entry) => entry.permission === 'admin:write')).toBe(true);

    // Refused BEFORE the repo: the row is exactly where it started.
    expect((await usersAdminRepo.find(maraId))?.suspended).toBe(false);
  },
);
