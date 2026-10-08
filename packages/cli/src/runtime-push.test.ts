// The boot's push half: `pwa.push` off owes nothing, on and deployed with no keys refuses BEFORE any
// service starts, on and local signs with the development pair, and the installed runtime is what
// the web role reads its `x-push-key` and `sw.js` push handler from.

import { afterEach, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { defineConfig } from '@ultimat3/core';
import { DEV_VAPID_KEYS, generateVapidKeys, installedVapid, resetWebPush } from '@ultimat3/pwa';
import { installAppWebPush, pushSubjectOf, selectWebPush } from './runtime-push';

afterEach(() => resetWebPush());

const PWA = {
  enabled: true,
  name: 'Fixture',
  offline: { fallback: '/offline' },
  colors: {
    light: { themeColor: '#1b1f3b', backgroundColor: '#ffffff' },
    dark: { themeColor: '#1b1f3b', backgroundColor: '#0b0d1a' },
  },
} as const;

const withPush = defineConfig({
  name: 'fixture',
  pwa: { ...PWA, push: true, vapid: { subject: 'mailto:ops@example.test' } },
});

const executor: PgExecutor = { query: async () => [] };

describe('unit · web push at boot', () => {
  test('push off, or no installable app, owes no runtime and reads no key', async () => {
    expect(pushSubjectOf(defineConfig({ name: 'fixture' }))).toBeUndefined();
    expect(pushSubjectOf(defineConfig({ name: 'fixture', pwa: PWA }))).toBeUndefined();
    expect(await selectWebPush(defineConfig({ name: 'fixture' }), {})).toBeUndefined();
  });

  test('push on in a deployed environment with no keys is refused by code, naming both', async () => {
    try {
      await selectWebPush(withPush, { ULTIMATE_ENV: 'production' });
      expect.unreachable('a deployed push app with no keys must not boot');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('X_PWA_VAPID_KEY_MISSING');
      expect((error as { fix?: string }).fix).toContain('x vapid create');
    }
  });

  test('push on locally signs with the development pair, and installing exposes it to the web role', async () => {
    const selection = await selectWebPush(withPush, { ULTIMATE_ENV: 'development' });
    expect(selection?.resolved).toEqual({ keys: DEV_VAPID_KEYS, source: 'development' });
    if (selection === undefined) return expect.unreachable('push is on');
    expect(installedVapid()).toBeUndefined();
    const release = await installAppWebPush(selection, executor);
    expect(installedVapid()).toEqual({
      publicKey: DEV_VAPID_KEYS.publicKey,
      subject: 'mailto:ops@example.test',
    });
    release();
    expect(installedVapid()).toBeUndefined();
  });

  test('a deployed environment with a real pair boots on it', async () => {
    const pair = await generateVapidKeys();
    const selection = await selectWebPush(withPush, {
      ULTIMATE_ENV: 'production',
      ULTIMATE_VAPID_PUBLIC_KEY: pair.publicKey,
      ULTIMATE_VAPID_PRIVATE_KEY: pair.privateKey,
    });
    expect(selection?.resolved).toEqual({ keys: pair, source: 'environment' });
  });
});
