// The harness route's refusals hand back an `x shot` / `x g island` line to paste. Every value in
// one comes off an island's states manifest — a file on disk the dev server imported — so each is
// screened where it enters the command (plan 101 row S12).

import { describe, expect, test } from 'bun:test';
import { createRequestContext, defineHttpConfig, UltimateRequest } from '@ultimat3/http';
import type { IslandStatesManifest } from '@ultimat3/testing';
import { defineIslandStates, islandShotTargets } from '@ultimat3/testing';
import { islandBundle } from './island-bundle';
import { ISLAND_HARNESS_PATH } from './island-harness';
import { islandHarnessRoutes } from './island-harness-route';

const DEV_URL = 'http://dev.localhost:3000';
const HOSTILE = 'apps/web/app/$(touch pwned)/x;y.island.tsx';

const manifestAt = (island: string, id: string): IslandStatesManifest =>
  defineIslandStates({
    island,
    timeZone: 'Europe/Bucharest',
    now: '2026-03-04T09:00:00.000Z',
    states: [{ id, title: 'a state', props: {} }],
  });

const refusalFix = async (manifest: IslandStatesManifest, query: string): Promise<string> => {
  const routes = islandHarnessRoutes({
    islands: () => islandBundle([]),
    states: () => Promise.resolve([manifest]),
    devUrl: () => DEV_URL,
  });
  const url = new URL(`${DEV_URL}${ISLAND_HARNESS_PATH}${query}`);
  const config = defineHttpConfig({ rateLimit: { scope: 'process' } });
  const ctx = createRequestContext({ url, method: 'GET', role: 'web', config });
  const route = routes[0] as (typeof routes)[number];
  const response = await route.handler(new UltimateRequest(new Request(url), ctx), ctx);
  expect(response.status).toBe(404);
  return ((await response.json()) as { error: { fix: string } }).error.fix;
};

describe('the harness refusals screen what the manifest says', () => {
  // A state id is slug-checked by `defineIslandStates`; the island path and the name derived from it
  // are not, and they are the hostile half.
  test('an unknown state: the island name never runs', async () => {
    const manifest = manifestAt(HOSTILE, 'empty');
    const fix = await refusalFix(
      manifest,
      `?island=${encodeURIComponent(HOSTILE)}&state=nope&theme=light`,
    );
    expect(fix).toBe("x shot --island 'x;y' --state empty --json");
  });

  test('a missing chunk: the island name and its directory never run', async () => {
    const manifest = manifestAt(HOSTILE, 'empty');
    const target = islandShotTargets(manifest)[0] as ReturnType<typeof islandShotTargets>[number];
    const fix = await refusalFix(manifest, target.query);
    expect(fix).toBe("x g island 'x;y' --at 'apps/web/app/$(touch pwned)'");
  });

  // L3 of the sweep 1c audit: quoting does not stop `x` reading a leading `-` as a flag.
  test('a name or directory opening with - is the placeholder, never an option', async () => {
    const manifest = manifestAt('-x/--json.island.tsx', 'empty');
    const target = islandShotTargets(manifest)[0] as ReturnType<typeof islandShotTargets>[number];
    expect(await refusalFix(manifest, target.query)).toBe("x g island '<island>' --at '<dir>'");
    const unknown = await refusalFix(
      manifest,
      `?island=${encodeURIComponent('-x/--json.island.tsx')}&state=nope&theme=light`,
    );
    expect(unknown).toBe("x shot --island '<island>' --state empty --json");
  });

  test('ordinary values still travel bare', async () => {
    const manifest = manifestAt('apps/web/app/settings/settings.island.tsx', 'empty');
    const target = islandShotTargets(manifest)[0] as ReturnType<typeof islandShotTargets>[number];
    expect(await refusalFix(manifest, target.query)).toBe(
      'x g island settings --at apps/web/app/settings',
    );
  });
});

// `/_x/island` renders an island with its declared state props off this machine's dev server. A
// page on a hostile name that resolves to 127.0.0.1 reads it same-origin unless the route refuses
// the Host the way every other `/_x` route does (K6).
describe('the harness answers a loopback Host only', () => {
  test('a non-loopback Host is a 421 X_DEV_HOST_REFUSED, before any states file is read', async () => {
    let read = 0;
    const routes = islandHarnessRoutes({
      islands: () => islandBundle([]),
      states: () => {
        read += 1;
        return Promise.resolve([]);
      },
      devUrl: () => DEV_URL,
    });
    const url = new URL(`http://rebound.example${ISLAND_HARNESS_PATH}?island=x&state=y`);
    const config = defineHttpConfig({ rateLimit: { scope: 'process' } });
    const ctx = createRequestContext({ url, method: 'GET', role: 'web', config });
    const route = routes[0] as (typeof routes)[number];
    const response = await route.handler(new UltimateRequest(new Request(url), ctx), ctx);
    expect(response.status).toBe(421);
    const body = (await response.json()) as { error: { code: string; fix: string } };
    expect(body.error.code).toBe('X_DEV_HOST_REFUSED');
    expect(body.error.fix).toContain(`${DEV_URL}/_x`);
    expect(read).toBe(0);
  });
});
