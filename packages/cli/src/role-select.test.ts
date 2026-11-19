// `x dev` runs the roles `app.config.ts` declares — the same rule the container's `ROLE` is refused
// by (`assertRoleDeclared`) — so a cron task does not fire in development for an app whose deploy
// runs no scheduler. Dropped roles are named in one boot line, never silently narrowed.

import { afterAll, afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
// why: Bun has no recursive remove, only a per-file delete.
import { mkdir, rm } from 'node:fs/promises';
import { defineConfig, logger } from '@ultimat3/core';
import { rolesDeclaredForDev, selectRoles, startRoles } from './role-start';
import { fixtureRuntime, resetDevRolesState } from './role-start-fixture';

const ROOT = `${import.meta.dir}/../.roles-declared-fixture`;

afterEach(() => {
  mock.restore();
  resetDevRolesState();
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('x dev runs only the roles app.config.ts declares', () => {
  test('a declared list narrows the selection and names what it dropped', () => {
    const info = spyOn(logger, 'info').mockImplementation(() => undefined);
    const config = defineConfig({ name: 'demo', roles: ['web', 'worker'] });

    expect(rolesDeclaredForDev(selectRoles(undefined), config)).toEqual(['web', 'worker']);
    const lines = info.mock.calls.map(([message]) => String(message));
    expect(
      lines.filter((line) => line.includes('scheduler') && line.includes('sync')),
    ).toHaveLength(1);
  });

  test('no config, or roles left at its default, runs the selection unchanged', () => {
    const all = selectRoles(undefined);
    expect(rolesDeclaredForDev(all, undefined)).toEqual(all);
    expect(rolesDeclaredForDev(all, defineConfig({ name: 'demo' }))).toEqual(all);
  });

  test('a selection of nothing but undeclared roles is refused with the declared ones', () => {
    const config = defineConfig({ name: 'demo', roles: ['web', 'worker'] });
    expect(() => rolesDeclaredForDev(selectRoles('scheduler'), config)).toThrow(/X_CONFIG_INVALID/);
  });

  test('the boot obeys it: a scheduler the app does not declare never starts', async () => {
    await mkdir(ROOT, { recursive: true });
    await Bun.write(
      `${ROOT}/app.config.ts`,
      "export const config = { name: 'demo', roles: ['web'] };\n",
    );
    spyOn(logger, 'info').mockImplementation(() => undefined);
    const running = await startRoles({
      roles: selectRoles('web,scheduler'),
      port: 0,
      buildId: 'test',
      runtime: fixtureRuntime(ROOT),
      env: {},
      routes: [],
      root: ROOT,
      http: { dev: true, hostname: 'localhost' },
    });
    try {
      expect(running.roles).toEqual(['web']);
      expect(running.scheduler).toBeNull();
    } finally {
      await running.stop();
    }
  });
});
