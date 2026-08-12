// `--role` used to be parsed and thrown away. These tests pin both halves of the fix: the flag
// selects, and the selection actually starts (and stops) the framework objects that role runs.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { METRICS_PATH, userActor } from '@ultimat3/core';
import { configureAuthenticator, cspHashSource, resetAuthenticator } from '@ultimat3/http';
import {
  createMemoryDriver,
  createMemoryEventBus,
  resetJobs,
  resetTasks,
  task,
} from '@ultimat3/jobs';
import { DEFAULT_PRESENCE_TTL_MS, InProcessTransport } from '@ultimat3/realtime';
import {
  clearRoutes,
  clearStylesheets,
  defineRoute,
  loadStylesheet,
  registerRoute,
} from '@ultimat3/render';
import { defineStorage, localDriver } from '@ultimat3/storage';
import { appRoutes } from './dev-render';
import type { RunningRoles } from './dev-roles';
import { DEV_ROLES, SELECTABLE_ROLES, selectRoles, startRoles } from './dev-roles';
import type { RunningServices } from './dev-runtime';
import { resolveServices } from './dev-services';

const ROOT = `${import.meta.dir}/../.roles-fixture`;

/** Every service a role touches, embedded but real — no PGlite boot for a role-wiring test. */
function fakeRuntime(): RunningServices {
  const services = resolveServices(ROOT, {});
  const transport = new InProcessTransport();
  return {
    services,
    db: { async ping() {}, async close() {} } as unknown as RunningServices['db'],
    jobs: createMemoryDriver(),
    events: createMemoryEventBus(),
    transport,
    transportDetail: 'in-process fanout',
    // The sync role reads this to build its `PresenceRegistry`; the default is what a boot with no
    // `NATS_URL` resolves to, so the fixture is the real number rather than a rounder one.
    presenceTtlMs: DEFAULT_PRESENCE_TTL_MS,
    storage: defineStorage({ disks: { local: localDriver({ root: `${ROOT}/storage` }) } }),
    stop: async () => transport.close(),
  };
}

/** The thrown value, so the matcher sees an error rather than a thunk. */
function refused(flag: string): unknown {
  try {
    selectRoles(flag);
  } catch (error) {
    return error;
  }
  return undefined;
}

let running: RunningRoles | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  resetJobs();
  resetTasks();
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('unit · x dev --role', () => {
  test('no flag runs every dev role', () => {
    expect(selectRoles(undefined)).toEqual(DEV_ROLES);
    expect(selectRoles('')).toEqual(DEV_ROLES);
    expect(DEV_ROLES).toEqual(['web', 'sync', 'worker', 'scheduler']);
  });

  test('a subset is honoured, deduped and kept in boot order', () => {
    expect(selectRoles('worker,web,worker')).toEqual(['web', 'worker']);
  });

  test('an unknown role is a flag error carrying the working invocation', () => {
    const thrown = refused('webb');
    expect(thrown).toBeUltimateError('X_CLI_BAD_FLAG');
    expect((thrown as { fix: string }).fix).toBe('x dev --role web,sync,worker,scheduler');
  });

  test('migrate is refused rather than silently dropped: it is a command, not a process', () => {
    expect(refused('migrate')).toBeUltimateError('X_CLI_BAD_FLAG');
  });

  test('replicator is selectable but never default — it takes the database its own slot', () => {
    expect(refused('replicator')).toBeUndefined();
    expect(selectRoles('replicator')).toEqual(['replicator']);
    expect(SELECTABLE_ROLES).toEqual(['web', 'sync', 'worker', 'scheduler', 'replicator']);
    expect(DEV_ROLES).not.toContain('replicator');
  });

  test('the replicator sorts last, after the transport it publishes to', () => {
    expect(selectRoles('replicator,sync')).toEqual(['sync', 'replicator']);
  });

  test('worker and scheduler start without a web server, and drain the queue', async () => {
    task({
      name: 'nightly',
      cron: '0 3 * * *',
      tz: 'UTC',
      job: { name: 'nightly-job', idempotencyKey: () => 'nightly' },
    });
    running = await startRoles({
      roles: selectRoles('worker,scheduler'),
      port: 0,
      buildId: 'test',
      runtime: fakeRuntime(),
      env: {},
      routes: [],
    });

    expect(running.roles).toEqual(['worker', 'scheduler']);
    expect(running.url).toBeNull();
    expect(running.syncUrl).toBeNull();
    expect(running.server).toBeNull();
    expect((await running.worker?.stats())?.state).toBe('running');
    expect(running.scheduler).not.toBeNull();

    // …and is still scrapable. `worker` opens no HTTP socket at all, so without the metrics
    // listener the `queue_depth` HPA in `docker/helm` has nowhere to read from and sits at
    // `<unknown>` forever — which is what it did.
    const scrape = await fetch(`${running.metricsUrl}${METRICS_PATH}`);
    expect(scrape.status).toBe(200);
    expect(await scrape.text()).toContain('# TYPE queue_depth gauge');
  });

  test('the web role serves the routes it was handed, and nothing else starts', async () => {
    running = await startRoles({
      roles: selectRoles('web'),
      port: 0,
      buildId: 'test',
      runtime: fakeRuntime(),
      env: {},
      routes: [
        {
          method: 'GET',
          path: '/_x/ping',
          meta: { name: 'ping', auth: 'public' },
          handler: () => new Response('pong'),
        },
      ],
    });

    expect(running.worker).toBeNull();
    expect(running.scheduler).toBeNull();
    expect(running.url).toStartWith('http://');
    const response = await running.server?.fetch(new Request('http://dev.test/_x/ping'));
    expect(await response?.text()).toBe('pong');
  });

  test('the sync role reports the socket it bound, not the port that was asked for', async () => {
    running = await startRoles({
      roles: selectRoles('sync'),
      // The bug: `port + 1` turned an ephemeral request into a request for port 1, and the
      // reported url was built from the number rather than read from the listener.
      port: 0,
      buildId: 'test',
      runtime: fakeRuntime(),
      env: {},
      routes: [],
    });

    const url = new URL(running.syncUrl ?? '');
    expect(url.protocol).toBe('ws:');
    expect(Number.parseInt(url.port, 10)).toBeGreaterThan(1);
  });

  test('a role that cannot bind rejects instead of handing back a half-started set', async () => {
    // Occupy the port the sync role will ask for, so `startSync` is the step that throws and the
    // web role started before it is the one the unwind has to give back.
    const blocker = Bun.serve({ port: 0, fetch: () => new Response('taken') });

    await expect(
      startRoles({
        roles: selectRoles('web,sync'),
        port: blocker.port - 1,
        // Explicit, because `port` is not 0 here: the fixed 9090 would make this test fail on
        // whichever machine already runs a Prometheus, for a reason that is not the one under test.
        metricsPort: 0,
        buildId: 'test',
        runtime: fakeRuntime(),
        env: {},
        routes: [],
      }),
    ).rejects.toThrow();

    blocker.stop(true);
  });
});

/**
 * `startWeb` passed `devHooks()`, which returned `authorize` and nothing else — so
 * `hooks.authenticate` had no caller anywhere in the framework and `auth: 'required'` was
 * unsatisfiable under `x dev` AND under `apps/web/server.ts`, which boots through this same
 * function. This is that wiring, driven end to end: the app declares the resolver, the web role
 * picks it up, and the `auth` stage calls it.
 */
describe('integration · the web role resolves an actor from the request', () => {
  afterEach(resetAuthenticator);

  const routes = [
    {
      method: 'GET' as const,
      path: '/whoami',
      meta: { name: 'whoami', auth: 'required' as const },
      handler: (_request: unknown, ctx: { actor: { id: string } }) => new Response(ctx.actor.id),
    },
  ];

  test('a session cookie becomes the actor; no cookie is still a 401', async () => {
    let calls = 0;
    configureAuthenticator((request) => {
      calls += 1;
      const session = request.cookie('session');
      return session === null ? null : userActor({ id: session });
    });

    running = await startRoles({
      roles: selectRoles('web'),
      port: 0,
      buildId: 'test',
      runtime: fakeRuntime(),
      env: {},
      routes,
    });

    const anonymous = await running.server?.fetch(new Request('http://dev.test/whoami'));
    expect(anonymous?.status).toBe(401);

    const signedIn = await running.server?.fetch(
      new Request('http://dev.test/whoami', { headers: { cookie: 'session=u-7' } }),
    );
    expect(signedIn?.status).toBe(200);
    expect(await signedIn?.text()).toBe('u-7');
    expect(calls).toBe(2);
  });

  test('an app that declares no authenticator still boots — every caller is anonymous', async () => {
    running = await startRoles({
      roles: selectRoles('web'),
      port: 0,
      buildId: 'test',
      runtime: fakeRuntime(),
      env: {},
      routes,
    });

    const response = await running.server?.fetch(new Request('http://dev.test/whoami'));
    expect(response?.status).toBe(401);
  });
});

/**
 * The bug this pins: the web role sent `style-src 'self'` and every document it served carried its
 * surface's CSS in an inline `<style>`, so the browser parsed zero rules out of it and every
 * deployed app rendered completely unstyled. A header-shaped unit test would not have caught it —
 * the question is whether THIS response's policy admits THIS response's body.
 */
describe('the CSP the web role sends admits the styles it serves', () => {
  /** Every `<style>` body in the document that no source in the policy names. */
  const uncovered = (body: string, csp: string): readonly string[] =>
    [...body.matchAll(/<style>([\s\S]*?)<\/style>/g)]
      .map((match) => match[1] ?? '')
      .filter((css) => !csp.includes(cspHashSource(css)));

  const page = (): void => {
    registerRoute({
      file: 'apps/web/site/page.tsx',
      suspenseBoundaries: 0,
      config: defineRoute<{ url: string; params: Record<string, string> }>({
        render: 'static',
        offline: 'network-only',
        hydrate: 'never',
        budget: { js: '0kb' },
        meta: () => ({ title: 'styled', description: 'styled' }),
      }),
    });
  };

  afterEach(() => {
    clearRoutes();
    clearStylesheets();
  });

  test('a page document is covered by the enforced policy the same response carries', async () => {
    loadStylesheet('/srv/demo/apps/web/site/page.module.scss', '.hero{color:red}');
    page();
    running = await startRoles({
      roles: selectRoles('web'),
      port: 0,
      buildId: 'test',
      runtime: fakeRuntime(),
      env: {},
      routes: appRoutes({ buildId: 'test' }),
      // A container's binding: `dev: false` is what turns the policy from report-only into the
      // enforced one, which is the only mode in which this failure is visible at all.
      http: { dev: false, hostname: 'localhost' },
    });

    const response = await running.server?.fetch(new Request('http://dev.test/'));
    const body = (await response?.text()) ?? '';
    const csp = response?.headers.get('content-security-policy') ?? '';

    expect(body).toContain('color:red');
    expect(csp).not.toContain("style-src 'self';");
    expect(uncovered(body, csp)).toEqual([]);
  });

  test('a document the caller mounted itself is covered once it declares its style', async () => {
    page();
    running = await startRoles({
      roles: selectRoles('web'),
      port: 0,
      buildId: 'test',
      runtime: fakeRuntime(),
      env: {},
      routes: appRoutes({ buildId: 'test' }),
      http: { dev: false, hostname: 'localhost' },
      // What `x dev` passes for `/_x`: a body no stylesheet registry holds.
      inlineStyles: ['body{margin:0}'],
    });

    const csp =
      (await running.server?.fetch(new Request('http://dev.test/')))?.headers.get(
        'content-security-policy',
      ) ?? '';
    expect(uncovered('<style>body{margin:0}</style>', csp)).toEqual([]);
  });
});
