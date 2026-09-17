// puppeteer-core is the APP's dependency and never this package's, so the two things worth proving
// are that the refusal is an instruction and that the resolution happens against the app's tree.
// Both run with no browser installed anywhere, which is the whole point of the injected launcher.

import { describe, expect, test } from 'bun:test';
import { CDP_DRIVER } from '@ultimat3/scraping';
import {
  appBrowser,
  BROWSER_CDP_URL_VAR,
  BROWSER_PACKAGE,
  browserBinaryExists,
  cdpUrlFrom,
  cdpUrlProblem,
  executablePathFrom,
} from './browser-launcher';
import { CONTAINER_CHROME_ARGS } from './cdp-launch';

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
        load: () => Promise.resolve({ notALauncher: () => undefined }),
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

/**
 * Defect D: `x shot` cannot launch Chrome where `x verify`'s e2e driver can — on Ubuntu 23.10+,
 * AppArmor restricts the unprivileged user namespace Chrome's sandbox needs, and Chrome exits
 * "No usable sandbox". `cdp-launch.ts`'s launcher already carries `--no-sandbox` and
 * `--disable-dev-shm-usage` for exactly this container fact (see its own header); this launcher —
 * a DIFFERENT process, `puppeteer-core`'s own `launch()` rather than `Bun.spawn` — passed neither,
 * so the same box that runs the e2e gate green cannot run `x shot`. The two launchers must agree,
 * for a LOCAL launch — an attach (`cdpUrl` set) starts nothing here and must read no local flag.
 */
describe('unit · a local launch gets the same container flags the e2e driver already needed', () => {
  // `appBrowser` only builds the driver — `launch()` / `connect()` are not called until `open()`
  // asks for a page, exactly like the real `runShot` call site. So the fake browser must survive
  // far enough into `open()` for the call to have happened; it need not survive further; the
  // resulting error (a fake page with no real methods) is caught and ignored, because it is
  // this test's plumbing, not its subject.
  const fakeBrowser = { newPage: () => Promise.resolve({}), close: () => Promise.resolve() };
  const init = {
    name: 'x shot',
    rules: { allowHosts: ['dev.test'] },
    clock: { now: () => new Date(0), sleep: () => Promise.resolve() },
    timeoutMs: 1_000,
  };

  test('launch() receives --no-sandbox and --disable-dev-shm-usage', async () => {
    let seen: Record<string, unknown> | undefined;
    const launcher = {
      launch: (launchOptions: Record<string, unknown>) => {
        seen = launchOptions;
        return Promise.resolve(fakeBrowser);
      },
    };
    const driver = await appBrowser({
      root: '/srv/app',
      executablePath: '/usr/bin/google-chrome',
      resolve: () => '/entry.js',
      load: () => Promise.resolve(launcher),
    });
    await driver.open(init as never).catch(() => undefined);
    const args = (seen?.['args'] ?? []) as readonly string[];
    for (const flag of CONTAINER_CHROME_ARGS) {
      expect(args).toContain(flag);
    }
  });

  test('an attach reads no local container flag — nothing is launched here', async () => {
    let seen: Record<string, unknown> | undefined;
    const launcher = {
      connect: (connectOptions: Record<string, unknown>) => {
        seen = connectOptions;
        return Promise.resolve(fakeBrowser);
      },
    };
    const driver = await appBrowser({
      root: '/srv/app',
      cdpUrl: 'wss://cdp.example.com/session/abc',
      resolve: () => '/entry.js',
      load: () => Promise.resolve(launcher),
    });
    await driver.open(init as never).catch(() => undefined);
    expect(seen?.['args']).toBeUndefined();
  });
});

describe('unit · which binary a run launches', () => {
  /** Injected, so the probe's four paths are asserted the same on a box with Chrome and without. */
  const nothingInstalled = (): boolean => false;

  test('the flag wins, then PUPPETEER_EXECUTABLE_PATH, then CHROME_PATH', () => {
    const env = { PUPPETEER_EXECUTABLE_PATH: '/env/chrome', CHROME_PATH: '/fallback/chrome' };
    expect(executablePathFrom('/flag/chrome', env, nothingInstalled)).toBe('/flag/chrome');
    expect(executablePathFrom(undefined, env, nothingInstalled)).toBe('/env/chrome');
    expect(
      executablePathFrom(undefined, { CHROME_PATH: '/fallback/chrome' }, nothingInstalled),
    ).toBe('/fallback/chrome');
  });

  /**
   * The last resort, and the reason this function exists at all: `puppeteer-core` bundles no
   * browser, so "nothing named" was never "the library finds its own" — it was a throw from inside
   * the library. `cdp-launch.ts` has probed these four paths for the e2e driver since it shipped;
   * `x shot` now reads the same list instead of a second one.
   */
  test('nothing named falls back to the probe the e2e driver already uses', () => {
    expect(executablePathFrom(undefined, {}, (path) => path === '/usr/bin/google-chrome')).toBe(
      '/usr/bin/google-chrome',
    );
    // First hit wins, in the list's own order — the operator's `CHROME_PATH` is above all four.
    expect(executablePathFrom(undefined, {}, (path) => path.startsWith('/usr/bin/chromium'))).toBe(
      '/usr/bin/chromium',
    );
    expect(executablePathFrom(undefined, { CHROME_PATH: '/named' }, () => true)).toBe('/named');
  });

  // Undefined, never `''`: `localBrowser` omits the key entirely for undefined and would otherwise
  // hand puppeteer an empty path to launch. `shotBrowserChoice` turns this into the refusal.
  test('nothing named and nothing installed is undefined', () => {
    expect(executablePathFrom(undefined, {}, nothingInstalled)).toBeUndefined();
    expect(
      executablePathFrom('', { PUPPETEER_EXECUTABLE_PATH: '' }, nothingInstalled),
    ).toBeUndefined();
  });

  test('a named binary is checked against the filesystem', () => {
    expect(browserBinaryExists(import.meta.path)).toBe(true);
    expect(browserBinaryExists('/no/such/chrome')).toBe(false);
  });
});

/**
 * Attaching is what every stealth provider sells: a session created over their API answers with a
 * `wss://` CDP endpoint, and the browser behind it is one this box could not have launched. The
 * property under test is that the run asks the library for the method it is actually going to
 * call — `connect` when a URL was given, `launch` when it was not — because `cdp-port.ts` declares
 * both optional exactly so an attach-only SDK satisfies the port.
 */
describe('unit · a browser somebody else is running', () => {
  const connectOnly = { connect: () => Promise.resolve({}) };
  const launchOnly = { launch: () => Promise.resolve({}) };
  const resolved = '/srv/app/node_modules/puppeteer-core/lib/index.js';

  test('a connect-only library is accepted with a cdpUrl and refused without one', async () => {
    const attached = await appBrowser({
      root: '/srv/app',
      cdpUrl: 'wss://cdp.example.com/session/abc',
      resolve: () => resolved,
      load: () => Promise.resolve(connectOnly),
    });
    expect(attached.name).toBe(CDP_DRIVER);

    // The same module, no URL: this run is going to `launch()` and there is none, so it is the
    // install instruction rather than a TypeError at a property access.
    const error = await thrownBy(() =>
      appBrowser({
        root: '/srv/app',
        resolve: () => resolved,
        load: () => Promise.resolve(connectOnly),
      }),
    );
    expect(error['code']).toBe('X_SHOT_BROWSER_MISSING');
    expect(String(error['cause'])).toContain('exports no launch()');
  });

  test('a launch-only library is refused for an attach, naming connect()', async () => {
    const error = await thrownBy(() =>
      appBrowser({
        root: '/srv/app',
        cdpUrl: 'wss://cdp.example.com/session/abc',
        resolve: () => resolved,
        load: () => Promise.resolve(launchOnly),
      }),
    );
    expect(error['code']).toBe('X_SHOT_BROWSER_MISSING');
    expect(String(error['cause'])).toContain('exports no connect()');
  });

  test('the flag wins over the environment, and an empty value is not a value', () => {
    const env = { [BROWSER_CDP_URL_VAR]: 'wss://from-env/session' };
    expect(cdpUrlFrom('wss://from-flag/session', env)).toBe('wss://from-flag/session');
    expect(cdpUrlFrom(undefined, env)).toBe('wss://from-env/session');
    expect(cdpUrlFrom('', env)).toBe('wss://from-env/session');
    expect(cdpUrlFrom(undefined, { [BROWSER_CDP_URL_VAR]: '' })).toBeUndefined();
    expect(cdpUrlFrom(undefined, {})).toBeUndefined();
  });

  test('the scheme is judged here, so a typo costs no provider session', () => {
    expect(cdpUrlProblem('wss://cdp.browser-use.com/abc')).toBeUndefined();
    expect(cdpUrlProblem('ws://127.0.0.1:9222/devtools/browser/x')).toBeUndefined();
    // A sidecar's `/json/version` endpoint is HTTP, and puppeteer resolves it to the socket itself.
    expect(cdpUrlProblem('http://chrome:9222')).toBeUndefined();
    expect(String(cdpUrlProblem('cdp.example.com'))).toContain('is not a URL');
    expect(String(cdpUrlProblem('file:///tmp/x'))).toContain('has scheme "file:"');
  });
});
