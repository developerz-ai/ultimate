// "Which build answers" is the one question a deploy check asks every replica, and every page
// answers it in `x-ultimate-build`. The health paths did not (#734): a check polling `/readyz` for
// the new build had to read a page instead. The header is public already, so every listener a
// booted process opens sends it on `/healthz`, `/readyz` and `/readyz?deep=1` — the web port and
// the scrape port alike — while the BODY stays what it was: the stranger's verdict (#53).

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
import { BUILD_ID_HEADER, resetLifecycle } from '@ultimat3/core';
import type { RunningRoles } from './role-start';
import { startRoles } from './role-start';
import { fixtureRuntime, resetDevRolesState } from './role-start-fixture';

const ROOT = `${import.meta.dir}/../.roles-health-build-fixture`;
const BUILD = 'build-734';
let running: RunningRoles | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  resetDevRolesState();
  resetLifecycle();
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

const PATHS = ['/healthz', '/readyz', '/readyz?deep=1'];

/**
 * `verdictOnly`: the scrape port tells everyone the verdict alone. The web port tells this test's
 * loopback socket the whole report (`healthDetailPeers` defaults to the box itself), so only the
 * header is asserted there; the stranger's web body is `health-disclosure.test.ts`'s.
 */
async function expectStamped(base: string, verdictOnly: boolean): Promise<void> {
  for (const path of PATHS) {
    const response = await fetch(`${base}${path}`);
    expect({ path, build: response.headers.get(BUILD_ID_HEADER) }).toEqual({ path, build: BUILD });
    const body = (await response.json()) as Record<string, unknown>;
    if (verdictOnly) {
      expect(Object.keys(body).sort()).toEqual(['ready', 'role', 'state']);
      expect(JSON.stringify(body)).not.toContain(BUILD);
    }
  }
}

describe('unit · the health answers name the build in the header', () => {
  test('the web port and the scrape port both send x-ultimate-build', async () => {
    resetLifecycle();
    running = await startRoles({
      roles: ['web'],
      port: 0,
      metricsPort: 0,
      buildId: BUILD,
      runtime: fixtureRuntime(ROOT),
      env: {},
      routes: [],
    });
    expect(running.url).not.toBeNull();
    await expectStamped(running.url ?? '', false);
    await expectStamped(running.metricsUrl, true);
  });

  test('a listener-less role answers on its scrape port with the build too', async () => {
    resetLifecycle();
    running = await startRoles({
      roles: ['scheduler'],
      port: 0,
      metricsPort: 0,
      buildId: BUILD,
      runtime: fixtureRuntime(ROOT),
      env: {},
      routes: [],
    });
    await expectStamped(running.metricsUrl, true);
  });
});
