// `startRoles` tells core's `bootWarning` which roles this process runs, once, and its stop takes
// that back: a worker replica is not concerned by a web-only line, whatever `ROLE` says.

import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
import { bootWarning, resetBootWarnings } from '@ultimat3/core';
import type { RunningRoles } from './role-start';
import { selectRoles, startRoles } from './role-start';
import { fixtureRuntime, resetDevRolesState } from './role-start-fixture';
import { appRoutes } from './runtime-render';

const ROOT = `${import.meta.dir}/../.roles-boot-warnings-fixture`;

let running: RunningRoles | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  resetDevRolesState();
  resetBootWarnings();
  await rm(ROOT, { recursive: true, force: true });
});

const quiet = { warn: () => undefined };
const say = (role: 'web' | 'worker') =>
  bootWarning({ code: 'X_APP_TEST_LINE', roles: [role], message: 'm' }, { log: quiet });

describe('the roles a boot warning concerns', () => {
  test('a worker boot installs its roles, and its stop puts back the environment’s', async () => {
    running = await startRoles({
      roles: selectRoles('worker'),
      port: 0,
      buildId: 'test',
      runtime: fixtureRuntime(ROOT),
      env: {},
      routes: appRoutes({ buildId: 'test' }),
      http: { dev: false, hostname: 'localhost' },
    });
    expect(await say('worker')).toBe(true);
    expect(await say('web')).toBe(false);
    await running.stop();
    running = undefined;
    // Released: `ROLE` is unset in a test run, so the process is `web` again.
    expect(await say('web')).toBe(true);
    expect(await say('worker')).toBe(false);
  });
});
