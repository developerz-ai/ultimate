// A route load reading the app's own API through its typed client is answered in process during
// `x exercise`, authenticated as the actor the load runs as — never the network, which the pass
// seals, and never a server, which nobody started.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { action, resetActions, rpc } from '@ultimat3/action';
import { registerAction } from '@ultimat3/action/loader';
import type { Actor } from '@ultimat3/core';
import { BUILD_ID_HEADER, userActor } from '@ultimat3/core';
import { installBuildId } from '@ultimat3/core/adapter';
import { withRequestAs } from '@ultimat3/http';
import { can, definePermissions } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { RouteLoadSubject } from '@ultimat3/testing';
import { EXERCISE_APP_URL, servedInProcess } from './exercise-route-api';

const whoAmI = action({
  input: t.object({}),
  output: t.object({ id: t.string }),
  policy: can('era-self:read'),
  handle: ({ ctx }) => ({ id: ctx.actor.id }),
});

// Registered in `beforeAll`: the registry is process-global, and this file's own is undone at its end.
beforeAll(() => {
  definePermissions(['era-self:read']);
  resetActions();
  registerAction('eraWhoAmI', whoAmI);
});

afterAll(() => resetActions());

const client = rpc<{ eraWhoAmI: typeof whoAmI }>({ baseUrl: EXERCISE_APP_URL });

const subject: RouteLoadSubject = {
  path: '/era/me',
  file: 'apps/web/app/era/me/page.tsx',
  params: [],
  load: async () => client.eraWhoAmI({}),
};

const READER: Actor = userActor({ id: 'era-reader', roles: [], permissions: ['era-self:read'] });

const loadAs = (route: RouteLoadSubject, actor: Actor | null): Promise<unknown> =>
  withRequestAs('era', actor, undefined, () =>
    route.load({ params: {}, url: `${EXERCISE_APP_URL}/era/me` }),
  );

describe('unit · route loads served by the app’s API in process', () => {
  test('the typed call is answered by the action, as the load’s own actor', async () => {
    const [served] = servedInProcess([subject]);
    if (served === undefined) return expect.unreachable('one route in, one out');
    expect(await loadAs(served, READER)).toEqual({ id: 'era-reader' });
  });

  test('signed out, the API sees nobody and its policy refuses', async () => {
    const [served] = servedInProcess([subject]);
    if (served === undefined) return expect.unreachable('one route in, one out');
    const refused = await loadAs(served, null).then(
      () => 'answered',
      (error: unknown) => (error as { readonly code?: string }).code ?? 'uncoded',
    );
    expect(refused).toStartWith('X_');
    expect(refused).not.toBe('X_TEST_NETWORK_SEALED');
  });

  test('unserved, the same load goes to the network', async () => {
    const reached = await loadAs(subject, READER).then(
      () => 'answered',
      (error: unknown) => (error as { readonly code?: string }).code ?? 'uncoded',
    );
    expect(reached).not.toBe('answered');
  });

  test('a prerender() sample reads the API in process too, as nobody', async () => {
    const sampled: RouteLoadSubject = {
      ...subject,
      samples: async () => [
        await client.eraWhoAmI({}).then(
          () => 'answered',
          (e: unknown) => (e as { readonly code?: string }).code ?? 'uncoded',
        ),
      ],
    };
    const [served] = servedInProcess([sampled]);
    const got = await served?.samples?.();
    // Nobody may read it, so the API itself refused — the network, which the pass seals, never did.
    expect(got?.[0]).toStartWith('X_');
    expect(got?.[0]).not.toBe('X_TEST_NETWORK_SEALED');
    expect(await sampled.samples?.()).toEqual(['X_TEST_NETWORK_SEALED']);
  });

  // A vendor call in a page read is a call out, never the app's: the pass seals it and records the
  // refusal — the app's router answering it 404 would hide which host the page dialled.
  test('a fetch to another origin inside a served load reaches the sealed network, not the API', async () => {
    const vendor: RouteLoadSubject = {
      ...subject,
      load: async () => fetch('https://api.vendor.invalid/v1/rates'),
    };
    const [served] = servedInProcess([vendor]);
    if (served === undefined) return expect.unreachable('one route in, one out');
    const refused = await loadAs(served, READER).then(
      () => 'answered',
      (error: unknown) => (error as { readonly code?: string }).code ?? 'uncoded',
    );
    expect(refused).toBe('X_TEST_NETWORK_SEALED');
  });

  // The pass answers as the build core holds — never `BUILD_ID` re-read, whose `''` an unstamped
  // image carries while every other surface names the resolved id.
  test('the in-process API answers with the build id core holds, not the raw BUILD_ID', async () => {
    const before = process.env['BUILD_ID'];
    process.env['BUILD_ID'] = '';
    const release = installBuildId('exercise-build-1');
    try {
      const raw: RouteLoadSubject = {
        ...subject,
        load: async () =>
          (await fetch(`${EXERCISE_APP_URL}/era/none`)).headers.get(BUILD_ID_HEADER),
      };
      const [served] = servedInProcess([raw]);
      if (served === undefined) return expect.unreachable('one route in, one out');
      expect(await loadAs(served, READER)).toBe('exercise-build-1');
    } finally {
      release();
      if (before === undefined) delete process.env['BUILD_ID'];
      else process.env['BUILD_ID'] = before;
    }
  });
});
