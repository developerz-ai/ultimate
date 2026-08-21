// puppeteer-core is the APP's dependency and never this package's, so the two things worth proving
// are that the refusal is an instruction and that the resolution happens against the app's tree.
// Both run with no browser installed anywhere, which is the whole point of the injected launcher.

import { describe, expect, test } from 'bun:test';
import { CDP_DRIVER } from '@ultimat3/scraping';
import {
  appBrowser,
  BROWSER_PACKAGE,
  browserBinaryExists,
  executablePathFrom,
} from './browser-launcher';

const thrownBy = async (run: () => Promise<unknown>): Promise<Record<string, unknown>> =>
  run().then(
    () => ({}),
    (error: unknown) => error as Record<string, unknown>,
  );

describe('unit · a missing browser is an instruction', () => {
  test('a specifier that does not resolve names the install command', async () => {
    const error = await thrownBy(() =>
      appBrowser({
        root: '/srv/app',
        resolve: () => {
          throw new TypeError('Cannot find module "puppeteer-core"');
        },
      }),
    );
    expect([error['code'], error['fix']]).toEqual([
      'X_SHOT_BROWSER_MISSING',
      `bun add -d ${BROWSER_PACKAGE}`,
    ]);
    expect(String(error['cause'])).toContain('/srv/app');
  });

  // `module.exports.default = module.exports` is a real CJS shape, and following it forever is a
  // stack overflow where the whole point of this function is to produce an instruction.
  test('a module whose default is itself is refused rather than followed', async () => {
    const selfReferential: Record<string, unknown> = { connect: () => undefined };
    selfReferential['default'] = selfReferential;
    const error = await thrownBy(() =>
      appBrowser({
        root: '/srv/app',
        resolve: () => '/entry.js',
        load: () => Promise.resolve(selfReferential),
      }),
    );
    expect(error['code']).toBe('X_SHOT_BROWSER_MISSING');
  });

  // A module that resolves and cannot launch is the same remedy and a different cause: `localBrowser`
  // would otherwise refuse at its own call site, one step further from the thing to fix.
  test('a module with no launch() is refused by name, not at a property access', async () => {
    const error = await thrownBy(() =>
      appBrowser({
        root: '/srv/app',
        resolve: () => '/srv/app/node_modules/puppeteer-core/lib/index.js',
        load: () => Promise.resolve({ connect: () => undefined }),
      }),
    );
    expect(error['code']).toBe('X_SHOT_BROWSER_MISSING');
    expect(String(error['cause'])).toContain('/srv/app/node_modules/puppeteer-core/lib/index.js');
  });
});

describe('unit · the app supplies the launcher', () => {
  const launcher = { launch: () => Promise.resolve({}) };

  test('a namespace with launch() becomes the real CDP driver', async () => {
    const driver = await appBrowser({
      root: '/srv/app',
      resolve: () => '/entry.js',
      load: () => Promise.resolve(launcher),
    });
    expect(driver.name).toBe(CDP_DRIVER);
  });

  // `import()` of a CJS build hands back `{ default: <the library> }`, which is the shape the
  // published puppeteer-core actually has under Bun.
  test('a CJS default export is unwrapped', async () => {
    const driver = await appBrowser({
      root: '/srv/app',
      resolve: () => '/entry.js',
      load: () => Promise.resolve({ default: launcher }),
    });
    expect(driver.name).toBe(CDP_DRIVER);
  });

  test('the app root is what the specifier is resolved against', async () => {
    const seen: string[] = [];
    await appBrowser({
      root: '/srv/app',
      resolve: (specifier, from) => {
        seen.push(`${specifier} from ${from}`);
        return '/entry.js';
      },
      load: () => Promise.resolve(launcher),
    });
    expect(seen).toEqual([`${BROWSER_PACKAGE} from /srv/app`]);
  });
});

describe('unit · which binary a run launches', () => {
  test('the flag wins, then PUPPETEER_EXECUTABLE_PATH, then CHROME_PATH', () => {
    const env = { PUPPETEER_EXECUTABLE_PATH: '/env/chrome', CHROME_PATH: '/fallback/chrome' };
    expect(executablePathFrom('/flag/chrome', env)).toBe('/flag/chrome');
    expect(executablePathFrom(undefined, env)).toBe('/env/chrome');
    expect(executablePathFrom(undefined, { CHROME_PATH: '/fallback/chrome' })).toBe(
      '/fallback/chrome',
    );
  });

  // Undefined, never `''`: `localBrowser` omits the key entirely for undefined and would otherwise
  // hand puppeteer an empty path to launch.
  test('nothing named anywhere is undefined, so the library finds its own', () => {
    expect(executablePathFrom(undefined, {})).toBeUndefined();
    expect(executablePathFrom('', { PUPPETEER_EXECUTABLE_PATH: '' })).toBeUndefined();
  });

  test('a named binary is checked against the filesystem', () => {
    expect(browserBinaryExists(import.meta.path)).toBe(true);
    expect(browserBinaryExists('/no/such/chrome')).toBe(false);
  });
});
