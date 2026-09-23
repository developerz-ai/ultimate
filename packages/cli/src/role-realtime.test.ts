// `realtime.enabled` as the boot obeys it: off means no `sync` node and no replicator in this
// process, and a process asked for nothing but those refuses rather than idling behind a probe.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
import { isUltimateError, type RealtimeConfig } from '@ultimat3/core';
import { rolesUnderRealtime } from './role-realtime';
import type { RunningRoles } from './role-start';
import { startRoles } from './role-start';
import { fixtureRuntime, resetDevRolesState } from './role-start-fixture';

const ROOT = `${import.meta.dir}/../.roles-realtime-fixture`;

const OFF: RealtimeConfig = { enabled: false, transport: 'memory', urlEnv: undefined };
const ON: RealtimeConfig = { enabled: true, transport: 'memory', urlEnv: undefined };

function refusal(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

let running: RunningRoles | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  resetDevRolesState();
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('rolesUnderRealtime', () => {
  test('enabled keeps every role it was given', () => {
    expect(rolesUnderRealtime(['web', 'sync', 'replicator'], ON)).toEqual([
      'web',
      'sync',
      'replicator',
    ]);
  });

  test('disabled drops sync and the replicator, and keeps the rest', () => {
    expect(rolesUnderRealtime(['web', 'sync', 'worker', 'scheduler'], OFF)).toEqual([
      'web',
      'worker',
      'scheduler',
    ]);
  });

  // `ROLE=sync` on an app whose config turned realtime off: a container that would bind nothing,
  // pass no probe and restart forever. Refused, naming the key and the edit.
  test('disabled with only realtime roles left refuses, naming realtime.enabled', () => {
    for (const roles of [['sync'], ['replicator'], ['sync', 'replicator']] as const) {
      const error = refusal(() => rolesUnderRealtime(roles, OFF));
      expect(isUltimateError(error) ? error.code : 'not coded').toBe('X_CONFIG_INVALID');
      const said = isUltimateError(error) ? `${error.cause} ${error.fix}` : '';
      expect(said).toContain('realtime.enabled');
      expect(said).toContain('app.config.ts');
    }
  });
});

describe('startRoles with realtime disabled', () => {
  test('web and sync asked for, web alone started: no sync node, no socket mount', async () => {
    running = await startRoles({
      roles: ['web', 'sync'],
      port: 0,
      buildId: 'test',
      runtime: fixtureRuntime(ROOT, OFF),
      env: {},
      routes: [],
    });

    expect(running.roles).toEqual(['web']);
    expect(running.url).not.toBeNull();
    expect(running.syncUrl).toBeNull();
    expect(running.liveRegistry).toBeNull();
  });

  test('the same roles with realtime enabled start the sync node', async () => {
    running = await startRoles({
      roles: ['web', 'sync'],
      port: 0,
      buildId: 'test',
      runtime: fixtureRuntime(ROOT, ON),
      env: {},
      routes: [],
    });

    expect(running.roles).toEqual(['web', 'sync']);
    expect(running.syncUrl).not.toBeNull();
  });
});
