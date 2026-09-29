// `--cookie name=value[,name=value]`: what a shot sets before the first navigation, read before
// anything boots so a malformed pair costs no dev server to report.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { fakeShotDriver } from './browser-launcher-fake';
import type { ShotDriver, ShotSessionInit } from './browser-launcher-port';
import { runShot } from './cmd-shot';
import { readCookieFlag, shotCookies } from './shot-cookie';

const dir = mkdtempSync(join(tmpdir(), 'x-shot-cookie-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('unit · readCookieFlag', () => {
  test('absent is no cookies', () => {
    expect(readCookieFlag(undefined)).toEqual([]);
  });

  test('pairs split on commas and on the FIRST equals sign', () => {
    expect(readCookieFlag('consent=granted, prefs=a=b')).toEqual([
      { name: 'consent', value: 'granted' },
      { name: 'prefs', value: 'a=b' },
    ]);
  });

  test('an empty value is a cookie, a missing equals sign is refused by name', () => {
    expect(readCookieFlag('seen=')).toEqual([{ name: 'seen', value: '' }]);
    expect(() => readCookieFlag('consent')).toThrow('X_CLI_BAD_FLAG');
  });

  test('a name or value no cookie header can carry is refused, not mangled', () => {
    expect(() => readCookieFlag('bad name=1')).toThrow('X_CLI_BAD_FLAG');
    expect(() => readCookieFlag('a=b;c')).toThrow('X_CLI_BAD_FLAG');
    expect(() => readCookieFlag('=x')).toThrow('X_CLI_BAD_FLAG');
  });

  test('each cookie is scoped to the app under test, and to nothing else', () => {
    expect(shotCookies([{ name: 'consent', value: 'granted' }], 'http://localhost:4321/')).toEqual([
      { name: 'consent', value: 'granted', url: 'http://localhost:4321/' },
    ]);
  });
});

describe('unit · runShot hands --cookie to the session', () => {
  test('scoped to the server the picture is of, before anything is opened', async () => {
    const seen: ShotSessionInit[] = [];
    const inner = fakeShotDriver([{ url: 'http://localhost:4321/', html: '<main>ok</main>' }]);
    const driver: ShotDriver = {
      name: inner.name,
      open: (init) => {
        seen.push(init);
        return inner.open(init);
      },
    };
    await runShot({
      route: '/',
      outDir: join(dir, 'root'),
      driver,
      boot: () =>
        Promise.resolve({ url: 'http://localhost:4321', origin: 'reused', stop: async () => {} }),
      settleMs: 0,
      timeoutMs: 1_000,
      fullPage: true,
      cookies: [{ name: 'consent', value: 'granted' }],
    });
    expect(seen[0]?.cookies).toEqual([
      { name: 'consent', value: 'granted', url: 'http://localhost:4321/' },
    ]);
  });
});
