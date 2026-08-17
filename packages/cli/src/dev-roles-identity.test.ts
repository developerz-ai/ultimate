// Single responsibility: where a booted role's ACTOR comes from. `dev-roles.test.ts` proves which
// roles `--role` starts and stops; this proves that a role which started can say who is calling —
// the web role over a request, the sync node over a socket, and the warning a process emits when
// nothing can answer at all.
//
// `startWeb` passed `devHooks()`, which returned `authorize` and nothing else, so
// `hooks.authenticate` had no caller anywhere in the framework: `auth: 'required'` was
// unsatisfiable under `x dev` AND under `apps/web/server.ts`, which boots through the same
// function. Every case here is driven end to end rather than off a hook table.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { logger, userActor } from '@ultimat3/core';
import type { Route } from '@ultimat3/http';
import { configureAuthenticator, resetAuthenticator } from '@ultimat3/http';
import type { RunningRoles } from './dev-roles';
import { selectRoles, startRoles } from './dev-roles';
import { fixtureRuntime, resetDevRolesState } from './dev-roles-fixture';

const ROOT = `${import.meta.dir}/../.roles-identity-fixture`;
const fakeRuntime = (): ReturnType<typeof fixtureRuntime> => fixtureRuntime(ROOT);

let running: RunningRoles | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  resetDevRolesState();
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

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
 * The sync node evaluated no credential of its own AND no host handed it one, so every socket the
 * framework ever opened carried `actorId: null` — the channel guard, the live-query gate, the
 * presence entry and the per-tenant cap all decided against an anonymous actor. Realtime was
 * single-tenant by wiring.
 */
describe('integration · the sync role is handed the app’s own authenticator', () => {
  afterEach(resetAuthenticator);

  const startSyncOnly = async (): Promise<readonly string[]> => {
    const lines: string[] = [];
    const original = logger.warn;
    logger.warn = (line: string) => lines.push(line);
    try {
      running = await startRoles({
        roles: ['sync'],
        port: 0,
        buildId: 'test',
        runtime: fakeRuntime(),
        routes: [],
        env: {},
      });
    } finally {
      logger.warn = original;
    }
    return lines;
  };

  test('no authenticator stays anonymous, loudly — the correct default for x dev', async () => {
    resetAuthenticator();
    const lines = await startSyncOnly();
    expect(lines.some((line) => line.includes('no authenticator'))).toBe(true);
  });

  test('an app that configured one is used, and the node stops saying it is anonymous', async () => {
    configureAuthenticator(() => userActor({ id: 'u1', roles: ['member'] }));
    const lines = await startSyncOnly();
    expect(lines.some((line) => line.includes('no authenticator'))).toBe(false);
  });
});

describe('unit · a server that cannot resolve an identity says so', () => {
  const guarded: Route = {
    method: 'GET',
    path: '/private',
    meta: { name: 'private', auth: 'required' },
    handler: () => new Response('ok'),
  };
  const open: Route = {
    method: 'GET',
    path: '/public',
    meta: { name: 'public', auth: 'public' },
    handler: () => new Response('ok'),
  };

  // The exact production state the demo app shipped in: guarded routes, no authenticator, a clean
  // boot, and a 401 on every valid session. Silence there is what let it survive to a deployment.
  test('guarded routes with no authenticator warn, naming the call that fixes it', async () => {
    resetAuthenticator();
    const lines: string[] = [];
    const original = logger.warn;
    logger.warn = (line: string) => lines.push(line);
    try {
      const running = await startRoles({
        roles: ['web'],
        port: 0,
        buildId: 'test',
        runtime: fakeRuntime(),
        routes: [open, guarded],
        env: {},
      });
      await running.stop();
    } finally {
      logger.warn = original;
    }
    const warned = lines.find((line) => line.includes('X_CONFIG_INVALID'));
    expect(warned).toBeDefined();
    expect(warned).toContain("1 route(s) declare auth: 'required'");
    expect(warned).toContain('configureAuthenticator()');
  });

  test('an app that configured one is silent', async () => {
    resetAuthenticator();
    configureAuthenticator(() => null);
    const lines: string[] = [];
    const original = logger.warn;
    logger.warn = (line: string) => lines.push(line);
    try {
      const running = await startRoles({
        roles: ['web'],
        port: 0,
        buildId: 'test',
        runtime: fakeRuntime(),
        routes: [guarded],
        env: {},
      });
      await running.stop();
    } finally {
      logger.warn = original;
      resetAuthenticator();
    }
    expect(lines.filter((line) => line.includes('X_CONFIG_INVALID'))).toEqual([]);
  });

  test('a route table with nothing guarded is silent', async () => {
    resetAuthenticator();
    const lines: string[] = [];
    const original = logger.warn;
    logger.warn = (line: string) => lines.push(line);
    try {
      const running = await startRoles({
        roles: ['web'],
        port: 0,
        buildId: 'test',
        runtime: fakeRuntime(),
        routes: [open],
        env: {},
      });
      await running.stop();
    } finally {
      logger.warn = original;
    }
    expect(lines.filter((line) => line.includes('X_CONFIG_INVALID'))).toEqual([]);
  });
});
