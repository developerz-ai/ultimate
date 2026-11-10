// The e2e preload outside the gate: with no app root named it must be INERT. It is loaded by the
// `e2e` step's `bun test --preload`, and an import that spawned an app or a browser anywhere else —
// a stray import, a coverage run — would be a Chrome and a Postgres nobody asked for.

import { expect, test } from 'bun:test';
import { DETECTED_ZONE_COOKIE } from '@ultimat3/render';
import type { E2eBrowser } from './cdp-browser';
import { E2E_ROOT_ENV, e2eBaseUrl } from './e2e-browser-handle';
import { seedDetectedZone } from './e2e-preload';

test('imported with no app root named, it spawns nothing and publishes no run', async () => {
  expect(Bun.env[E2E_ROOT_ENV] ?? '').toBe('');
  await import('./e2e-preload');

  expect(e2eBaseUrl()).toBeUndefined();
});

test('seeds the render-owned detected-zone cookie before the harness can use a browser', async () => {
  const calls: [string, string, string][] = [];
  const browser = {
    session: {
      setCookie: async (origin: string, name: string, value: string) => {
        calls.push([origin, name, value]);
      },
    },
  } as unknown as E2eBrowser;

  await seedDetectedZone(browser, 'http://127.0.0.1:4010', 'America/Los_Angeles');

  expect(calls).toEqual([['http://127.0.0.1:4010', DETECTED_ZONE_COOKIE, 'America/Los_Angeles']]);
});
