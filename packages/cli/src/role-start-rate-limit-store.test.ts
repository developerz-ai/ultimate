// Single responsibility: every role a boot starts counts primitives' declared `rateLimit:` in the
// ONE store the web role's limiter runs on — the deployment's override when it supplied one, else
// the shared store `startServices` resolved. A `worker` replica runs `.job()`s and opens no HTTP
// socket, so "the server's store" alone would leave every queued action counting in its own memory.

import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
import type { RateLimitStore } from '@ultimat3/http';
import {
  adoptRateLimitStore,
  installedRateLimitStore,
  memoryRateLimitStore,
  resetRateLimitStore,
} from '@ultimat3/http';
import type { RunningRoles } from './role-start';
import { selectRoles, startRoles } from './role-start';
import { fixtureRuntime, resetDevRolesState } from './role-start-fixture';
import { appRoutes } from './runtime-render';

const ROOT = `${import.meta.dir}/../.roles-rate-limit-store-fixture`;

let running: RunningRoles | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  resetDevRolesState();
  resetRateLimitStore();
  await rm(ROOT, { recursive: true, force: true });
});

const shared = (): RateLimitStore => ({ ...memoryRateLimitStore(), scope: 'shared' });

const boot = (roles: string, store: RateLimitStore, override?: RateLimitStore) =>
  startRoles({
    roles: selectRoles(roles),
    port: 0,
    buildId: 'test',
    runtime: { ...fixtureRuntime(ROOT), rateLimitStore: store },
    env: {},
    routes: appRoutes({ buildId: 'test' }),
    http: { dev: false, hostname: 'localhost' },
    ...(override === undefined ? {} : { overrides: { rateLimitStore: override } }),
  });

describe('the store primitives spend their declared limits from', () => {
  test('a worker replica installs the resolved shared store', async () => {
    const store = shared();
    running = await boot('worker', store);
    expect(installedRateLimitStore()).toBe(store);
  });

  test('a web replica installs the deployment’s override — the instance its server was handed', async () => {
    const override = shared();
    running = await boot('web', shared(), override);
    expect(installedRateLimitStore()).toBe(override);
  });

  test('stopping the roles puts back the store that was installed before them', async () => {
    const before = installedRateLimitStore();
    const store = shared();
    running = await boot('worker', store);
    await running.stop();
    running = undefined;
    expect(installedRateLimitStore()).toBe(before);
  });

  test('stopping takes back only this boot’s frame, not a store adopted after it', async () => {
    running = await boot('worker', shared());
    const later = shared();
    const releaseLater = adoptRateLimitStore(later);
    await running.stop();
    running = undefined;
    // The roles' stop restored "what was there before" over `later`, which was still in use.
    expect(installedRateLimitStore()).toBe(later);
    releaseLater();
  });
});
