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

test('the configured zone is seeded from render before initial and relaunched browser publication', async () => {
  const script = [
    "import { mock } from 'bun:test';",
    'const events = [];',
    "mock.module('@ultimat3/render', () => ({ DETECTED_ZONE_COOKIE: 'render-zone-cookie' }));",
    "mock.module('./packages/testing/src/cdp-browser.ts', () => ({",
    "  openE2eBrowser: async () => ({ session: { setCookie: async (...args) => events.push(['seed', ...args]) } }),",
    '}));',
    "mock.module('./packages/testing/src/e2e-app.ts', () => ({ startE2eApp: async () => ({ base: 'http://app.test' }) }));",
    "mock.module('./packages/testing/src/e2e-locale.ts', () => ({ e2eDefaultLocale: async () => undefined }));",
    "mock.module('./packages/testing/src/e2e-driver.ts', () => ({ installE2eDriver: () => () => undefined }));",
    "mock.module('./packages/testing/src/e2e-run.ts', () => ({",
    '  startE2eRun: async ({ openBrowser }) => {',
    "    events.push('before-initial-publication');",
    '    await openBrowser();',
    "    events.push('initial-published');",
    "    events.push('before-relaunch-publication');",
    '    await openBrowser();',
    "    events.push('relaunch-published');",
    '  },',
    '}));',
    "await import('./packages/testing/src/e2e-preload.ts');",
    'console.log(JSON.stringify(events));',
  ].join('\n');
  const child = Bun.spawn(['bun', '-e', script], {
    cwd: process.cwd(),
    env: {
      ...Bun.env,
      [E2E_ROOT_ENV]: 'fixture',
      TZ: 'America/Los_Angeles',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(exitCode).toBe(0);
  expect(stderr).toBe('');
  expect(JSON.parse(stdout) as unknown).toEqual([
    'before-initial-publication',
    ['seed', 'http://app.test', 'render-zone-cookie', 'America/Los_Angeles'],
    'initial-published',
    'before-relaunch-publication',
    ['seed', 'http://app.test', 'render-zone-cookie', 'America/Los_Angeles'],
    'relaunch-published',
  ]);
});
