// `x shot` drives a real browser, so every rule it holds is proved here through an INJECTED one:
// `fakeBrowser()` plus a stub server. A test that needed Chrome would be a test CI cannot run, and
// this command is deliberately not a step of `x verify` — so its suite must not need one either.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConsoleLine, ScrapeDriver, ScrapeSession } from '@ultimat3/scraping';
import { fakeBrowser } from '@ultimat3/scraping';
import {
  allowHostsFrom,
  devServerFor,
  readRoute,
  runShot,
  SHOT_IMAGE,
  SHOT_VERDICT,
  type ShotRun,
  type ShotServer,
  shotCommand,
  shotSlug,
} from './cmd-shot';
import type { CommandContext } from './command';
import { DEV_LOCK_FILE } from './dev-lock';
import { resolveServices } from './dev-services';
import { parseArgs } from './parse';
import { ISLAND_PROBE } from './shot-verdict';

const SERVER_URL = 'http://localhost:4321';
const ROUTE = '/dash';

const PAGE = [
  '<!doctype html><html><body>',
  '<div data-x-island="i1" data-x-hydrate="idle" data-x-entry="/_x/islands/a.js"></div>',
  '<div data-x-island="i2" data-x-hydrate="visible" data-x-entry="/_x/islands/b.js"></div>',
  '<div data-x-island="i3" data-x-hydrate="never"></div>',
  '</body></html>',
].join('');

const PROBE_ANSWER = JSON.stringify({
  declared: 3,
  booted: 2,
  mounted: 1,
  failed: 1,
  byStrategy: { idle: 1, visible: 1, never: 1 },
  failures: [{ island: 'cart', message: 'TypeError: total is not a function' }],
});

const siteDriver = (): ScrapeDriver =>
  fakeBrowser([
    { url: `${SERVER_URL}${ROUTE}`, html: PAGE, evaluate: { [ISLAND_PROBE]: PROBE_ANSWER } },
  ]);

/**
 * The offline drivers record no console lines — there is no JS engine to log — so the one seam
 * that can prove `runShot` reads `page.console()` at all is a driver that answers some. Composed
 * over the real fake rather than hand-built: everything else on the session stays honest.
 */
const withConsole = (base: ScrapeDriver, lines: readonly ConsoleLine[]): ScrapeDriver => ({
  name: base.name,
  open: async (init): Promise<ScrapeSession> => {
    const session = await base.open(init);
    return { ...session, page: { ...session.page, console: () => lines } };
  },
});

interface StubServer {
  readonly server: ShotServer;
  readonly stopped: () => number;
}

const stubServer = (url = SERVER_URL): StubServer => {
  let stops = 0;
  return {
    server: {
      url,
      origin: 'booted',
      stop: () => {
        stops += 1;
        return Promise.resolve();
      },
    },
    stopped: () => stops,
  };
};

const runFor = (outDir: string, overrides: Partial<ShotRun> = {}): ShotRun => ({
  route: ROUTE,
  outDir,
  driver: siteDriver(),
  boot: () => Promise.resolve(stubServer().server),
  settleMs: 0,
  timeoutMs: 1_000,
  fullPage: true,
  now: () => new Date('2026-08-21T09:00:00.000Z'),
  ...overrides,
});

let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'x-shot-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const readVerdict = async (out: string): Promise<Record<string, unknown>> =>
  (await Bun.file(join(out, SHOT_VERDICT)).json()) as Record<string, unknown>;

const thrownBy = async (run: () => Promise<unknown>): Promise<Record<string, unknown>> =>
  run().then(
    () => ({}),
    (error: unknown) => error as Record<string, unknown>,
  );

describe('unit · one route, two artifacts', () => {
  test('the picture and the verdict are written side by side', async () => {
    const out = join(dir, 'pair');
    const artifacts = await runShot(runFor(out));
    expect([existsSync(join(out, SHOT_IMAGE)), existsSync(join(out, SHOT_VERDICT))]).toEqual([
      true,
      true,
    ]);
    expect(artifacts.verdict.screenshot).toBe(SHOT_IMAGE);
    const verdict = await readVerdict(out);
    expect(verdict['route']).toBe(ROUTE);
    expect(verdict['requestedUrl']).toBe(`${SERVER_URL}${ROUTE}`);
    expect(verdict['capturedAt']).toBe('2026-08-21T09:00:00.000Z');
  });

  // The half a picture cannot carry: three islands rendered, two started by the runtime, one of
  // those RUNNING and one THREW — and the artifact names which one and what it said. A screenshot
  // of this page looks identical whether `cart` mounted or exploded.
  test('the island probe reaches the page and its answer reaches the artifact', async () => {
    const out = join(dir, 'islands');
    await runShot(runFor(out));
    expect((await readVerdict(out))['islands']).toEqual({
      declared: 3,
      booted: 2,
      mounted: 1,
      failed: 1,
      byStrategy: { idle: 1, visible: 1, never: 1 },
      failures: [{ island: 'cart', message: 'TypeError: total is not a function' }],
    });
  });

  test('a page the probe cannot answer leaves islands null and still writes the picture', async () => {
    const out = join(dir, 'unprobed');
    const driver = fakeBrowser([{ url: `${SERVER_URL}${ROUTE}`, html: PAGE }]);
    const artifacts = await runShot(runFor(out, { driver }));
    expect(artifacts.verdict.islands).toBeNull();
    expect(existsSync(join(out, SHOT_IMAGE))).toBe(true);
  });

  test("the page's console errors are what decide the verdict", async () => {
    const out = join(dir, 'console');
    const driver = withConsole(siteDriver(), [
      { level: 'error', text: 'mount failed: props is not defined', at: 3 },
    ]);
    const artifacts = await runShot(runFor(out, { driver }));
    expect([artifacts.verdict.ok, artifacts.verdict.errors]).toEqual([false, 1]);
    const verdict = (await readVerdict(out))['console'] as { errors: number };
    expect(verdict.errors).toBe(1);
  });
});

describe('unit · nothing is left running', () => {
  test('a navigation that fails still stops the server and writes no artifact', async () => {
    const out = join(dir, 'failed');
    const stub = stubServer();
    const error = await thrownBy(() =>
      runShot(
        runFor(out, {
          // A page nobody recorded: the offline driver refuses rather than reaching the network.
          driver: fakeBrowser([{ url: `${SERVER_URL}/other`, html: PAGE }]),
          boot: () => Promise.resolve(stub.server),
        }),
      ),
    );
    expect(error['code']).toBe('X_SCRAPE_FIXTURE_MISSING');
    expect(stub.stopped()).toBe(1);
    expect(existsSync(join(out, SHOT_IMAGE))).toBe(false);
  });

  test('a clean run stops the server exactly once', async () => {
    const stub = stubServer();
    await runShot(runFor(join(dir, 'stops'), { boot: () => Promise.resolve(stub.server) }));
    expect(stub.stopped()).toBe(1);
  });
});

describe('unit · the route argument', () => {
  test('a bare path is normalised, a missing one is a positional error', () => {
    expect([readRoute('/dash'), readRoute('dash'), readRoute(' /a ')]).toEqual([
      '/dash',
      '/dash',
      '/a',
    ]);
    expect(() => readRoute(undefined)).toThrow(/route/);
  });

  // A headless browser inside your network pointed at somebody else's site is the SSRF shape
  // `allowHosts` exists to refuse. Refused at the argument, where the reader can still see why.
  test('an absolute URL is refused, with a runnable route in the fix', () => {
    const error = (() => {
      try {
        readRoute('https://example.com/pricing');
        return {};
      } catch (thrown: unknown) {
        return thrown as Record<string, unknown>;
      }
    })();
    expect([error['code'], error['fix']]).toEqual(['X_CLI_BAD_FLAG', 'x shot /pricing --json']);
  });

  test('a slug can never climb out of the output directory', () => {
    expect([shotSlug('/'), shotSlug('/posts/[slug]'), shotSlug('/../../etc')]).toEqual([
      'root',
      'posts-slug',
      'etc',
    ]);
  });
});

describe('unit · the page may only talk to the app', () => {
  test("the app's own host is always allowed and named hosts are added", () => {
    expect(allowHostsFrom('http://localhost:4321', undefined)).toEqual(['localhost']);
    expect(allowHostsFrom('http://localhost:4321', 'fonts.example, cdn.example')).toEqual([
      'localhost',
      'fonts.example',
      'cdn.example',
    ]);
  });
});

describe('unit · which server the picture is of', () => {
  test('an x dev already running on this checkout is reused, never booted over', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x-shot-lock-'));
    const stateDir = resolveServices(root, {}).stateDir;
    writeFileSync(
      join(stateDir, DEV_LOCK_FILE),
      JSON.stringify({ pid: process.pid, port: 3000, url: 'http://localhost:3000' }),
    );
    const server = await devServerFor(root, {}, 0);
    expect([server.url, server.origin]).toEqual(['http://localhost:3000', 'reused']);
    // Stopping a server this command did not start must not clear the lock the other one owns.
    await server.stop();
    expect(existsSync(join(stateDir, DEV_LOCK_FILE))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('unit · x shot refuses before it boots anything', () => {
  let root = '';

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'x-shot-app-'));
    writeFileSync(join(root, 'app.config.ts'), 'export const config = {};\n');
  });

  const contextFor = (argv: readonly string[]): CommandContext => ({
    args: parseArgs(argv, [shotCommand.spec]),
    cwd: root,
    runner: (command) => expect.unreachable(`x shot spawned ${command.join(' ')}`),
    env: {},
    bunVersion: '1.3.0',
  });

  test('a port that is not a port is a flag error, not a NaN handed to Bun.serve', async () => {
    const error = await thrownBy(() => shotCommand.run(contextFor(['shot', '/', '--port', 'abc'])));
    expect(error['code']).toBe('X_CLI_BAD_FLAG');
  });

  test('a --browser naming no executable is refused before the launch', async () => {
    const error = await thrownBy(() =>
      shotCommand.run(contextFor(['shot', '/', '--browser', '/no/such/chrome'])),
    );
    expect([error['code'], error['fix']]).toEqual([
      'X_CLI_BAD_FLAG',
      'x shot / --browser /usr/bin/chromium',
    ]);
  });

  // The whole point of resolving the browser first: an app with none must not pay an embedded
  // Postgres boot to be told to run one install command.
  test('an app with no puppeteer-core is told to install it, and nothing is started', async () => {
    const error = await thrownBy(() => shotCommand.run(contextFor(['shot', '/'])));
    expect([error['code'], error['fix']]).toEqual([
      'X_SHOT_BROWSER_MISSING',
      'bun add -d puppeteer-core',
    ]);
    expect(existsSync(join(root, '.x'))).toBe(false);
  });
});
