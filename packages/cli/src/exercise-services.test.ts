// The runtime services `x exercise` stands in for: what a server's boot installs (a storage disk, a
// fleet-wide rate-limit store, the Web Push runtime) installed for the pass, so a primitive that
// reads one runs instead of needing `{ off }` — and each handed back as found.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AppConfig, PgExecutor } from '@ultimat3/core';
import { defineConfig, isUltimateError } from '@ultimat3/core';
import { installedRateLimitStore } from '@ultimat3/http';
import { resetRateLimitStore } from '@ultimat3/http/adapter';
import { pushToActor, resetWebPush, webPushRuntime } from '@ultimat3/pwa';
import { defineStorage, disk, memoryStorageDriver, resetStorage, storage } from '@ultimat3/storage';
import { installExerciseServices } from './exercise-services';

/** No statement is sent by installing: the stores are lazy, so a refusing executor proves it. */
const executor: PgExecutor = {
  query: async () => expect.unreachable('installing the exercise services ran a statement'),
};

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not an UltimateError';
  }
  return 'no refusal';
};

const pushApp = (): AppConfig =>
  defineConfig({
    name: 'exercise-services',
    pwa: {
      enabled: true,
      offline: { fallback: '/offline' },
      push: true,
      vapid: { subject: 'mailto:ops@example.test' },
      name: 'Exercise',
      colors: {
        light: { themeColor: '#1b1f3b', backgroundColor: '#ffffff' },
        dark: { themeColor: '#1b1f3b', backgroundColor: '#0b0d1a' },
      },
    },
  });

// Before as well as after: storage is process state, and on a shared worker an app module an
// earlier file imported had defined its own for good — "an app that defined no storage" is this
// file's premise, so it starts from none.
beforeEach(() => resetStorage());

afterEach(() => {
  resetStorage();
  resetRateLimitStore();
  resetWebPush();
});

describe('unit · the services x exercise installs', () => {
  test('an app that defined no storage gets a memory disk for the pass, and none after', async () => {
    const release = await installExerciseServices({ config: undefined, env: {}, executor });
    await disk().put('exercise/probe.txt', new TextEncoder().encode('held'));
    expect(await disk().exists('exercise/probe.txt')).toBe(true);
    release();
    expect(codeOf(() => storage())).toBe('X_CONFIG_INVALID');
  });

  test("an app's own storage is its own: never replaced, never reset", async () => {
    const own = defineStorage({ disks: { own: memoryStorageDriver() }, default: 'own' });
    const release = await installExerciseServices({ config: undefined, env: {}, executor });
    expect(storage()).toBe(own);
    release();
    expect(storage()).toBe(own);
  });

  test('the rate-limit store is fleet-wide for the pass, as a boot installs it', async () => {
    expect(installedRateLimitStore().scope).toBe('process');
    const release = await installExerciseServices({ config: undefined, env: {}, executor });
    expect(installedRateLimitStore().scope).toBe('shared');
    release();
    expect(installedRateLimitStore().scope).toBe('process');
  });

  test('an app with push wired gets a runtime whose sends are captured, never sent', async () => {
    const release = await installExerciseServices({ config: pushApp(), env: {}, executor });
    const runtime = webPushRuntime('exercise');
    const answered = await runtime.fetch('https://fcm.googleapis.com/fcm/send/x', {
      method: 'POST',
    });
    expect(answered.status).toBe(201);
    release();
    expect(codeOf(() => webPushRuntime('exercise'))).toBe('X_PWA_PUSH_UNCONFIGURED');
  });

  // A notifier's push reaches a device in the pass: every actor holds one stand-in subscription, as
  // the memory mail driver accepts every address — so a pusher that sends nothing is told apart.
  test('an actor with no stored device still receives one push, encrypted and captured', async () => {
    const empty: PgExecutor = { query: async () => [] };
    const release = await installExerciseServices({
      config: pushApp(),
      env: {},
      executor: empty,
    });
    try {
      const report = await pushToActor('actor-1', {
        titleKey: 'push.title',
        bodyKey: 'push.body',
        url: '/',
      });
      expect(report).toEqual({ delivered: 1, removed: 0, refused: 0 });
      const [device] = await webPushRuntime('exercise').store.listFor('actor-1');
      expect(device?.actorId).toBe('actor-1');
      expect(new URL(device?.endpoint ?? '').hostname).toBe('fcm.googleapis.com');
    } finally {
      release();
    }
  });

  // Push is selected last; a refused key pair must not strand the disk and the store before it.
  test('a refused install undoes what it already installed', async () => {
    const half = { ULTIMATE_VAPID_PUBLIC_KEY: 'BPublicHalfOnly' };
    const refused = installExerciseServices({ config: pushApp(), env: half, executor });
    await expect(refused).rejects.toMatchObject({ code: 'X_PWA_VAPID_KEY_MISSING' });
    expect(codeOf(() => storage())).toBe('X_CONFIG_INVALID');
    expect(installedRateLimitStore().scope).toBe('process');
  });

  test('an app with push off gets no push runtime', async () => {
    const release = await installExerciseServices({ config: undefined, env: {}, executor });
    expect(codeOf(() => webPushRuntime('exercise'))).toBe('X_PWA_PUSH_UNCONFIGURED');
    release();
  });
});
