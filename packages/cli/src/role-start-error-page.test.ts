// Which document a BROWSER gets from a started web role when the request fails. Split from
// `role-start.test.ts` for `role-start-csp.test.ts`'s reason: it asks nothing about which roles
// start, it asks what one started role answers.
//
// The bug it pins: `startWeb` is the one place `x dev` and the container both boot through, so an
// error page wired at either call site alone is a page that appears in dev and not in production —
// the failure `assetRoutes` already exists to prevent for `/favicon.ico`.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no path joiner and no recursive remove — the rule `cmd-db.test.ts` records.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import type { Route } from '@ultimat3/http';
import { clearRoutes } from '@ultimat3/render';
import { errorPageSource } from './error-pages';
import type { RunningRoles } from './role-start';
import { selectRoles, startRoles } from './role-start';
import { fixtureRuntime, resetDevRolesState } from './role-start-fixture';
import { appRoutes } from './runtime-render';

const ROOT = join(import.meta.dir, '..', '.roles-error-page-fixture');

let running: RunningRoles | undefined;

const SECRET = 'connect ECONNREFUSED 10.0.0.7:5432';

/** A route that fails on the server, so a 5xx is asked of the same started role as the 404. */
const boom: Route = {
  method: 'GET',
  path: '/boom',
  meta: { name: 'boom', auth: 'public' },
  handler: () => {
    throw new TypeError(SECRET);
  },
};

// `dev` is the whole question: a container's binding asks the app's file for every status, read
// once; `x dev`'s asks it for a 4xx only, read per request, and answers a 5xx with the overlay.
const startWebRole = async (dev = false): Promise<RunningRoles> =>
  startRoles({
    roles: selectRoles('web'),
    port: 0,
    buildId: 'test',
    runtime: fixtureRuntime(ROOT),
    env: {},
    routes: [boom, ...appRoutes({ buildId: 'test' })],
    root: ROOT,
    http: { dev, hostname: 'localhost' },
  });

const browserGet = async (path: string): Promise<Response | undefined> =>
  running?.server?.fetch(
    new Request(`http://dev.test${path}`, { headers: { accept: 'text/html' } }),
  );

const missingPage = (): Promise<Response | undefined> => browserGet('/nope');

afterEach(async () => {
  await running?.stop();
  running = undefined;
  clearRoutes();
  resetDevRolesState();
  await rm(ROOT, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('a browser that hits nothing, in production', () => {
  test("gets the framework's page — never the problem document", async () => {
    running = await startWebRole();
    const response = await missingPage();
    expect(response?.status).toBe(404);
    expect(response?.headers.get('content-type')).toContain('text/html');
    const body = (await response?.text()) ?? '';
    expect(body).toContain('Page not found');
    expect(body).toContain('https://github.com/developerz-ai/ultimate');
    expect(body).toContain('https://www.developerz.ai');
  });

  test("gets the app's own file when it wrote one, byte for byte", async () => {
    const own = '<!doctype html><title>ours</title><h1>Gone fishing</h1>';
    await Bun.write(join(ROOT, errorPageSource(404)), own);
    running = await startWebRole();
    expect(await (await missingPage())?.text()).toBe(own);
  });

  test('the CSP the same response carries admits the page it is', async () => {
    running = await startWebRole();
    const response = await missingPage();
    const csp = response?.headers.get('content-security-policy') ?? '';
    const body = (await response?.text()) ?? '';
    const styles = [...body.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1] ?? '');
    expect(styles.length).toBe(1);
    // The overlay's stylesheet, hashed into `style-src` since it shipped — which is exactly why
    // the error page renders that one and not a second body nothing hashes.
    expect(csp).toContain('sha256-');
    expect(
      styles.filter(
        (css) => !csp.includes(new Bun.CryptoHasher('sha256').update(css).digest('base64')),
      ),
    ).toEqual([]);
  });
});

// #492: the overlay answered every dev failure before the hook was read, so `perRequest` — the
// reason `x dev` reads the file on every request — was unreachable, and an author never saw the
// 404 page a visitor would.
describe('a browser, under x dev', () => {
  test("a 404 gets the app's own file, and an edit to it lands on the next request", async () => {
    const first = '<!doctype html><title>ours</title><h1>Gone fishing</h1>';
    const second = '<!doctype html><title>ours</title><h1>Back soon</h1>';
    await Bun.write(join(ROOT, errorPageSource(404)), first);
    running = await startWebRole(true);
    const response = await missingPage();
    expect(response?.status).toBe(404);
    expect(await response?.text()).toBe(first);
    await Bun.write(join(ROOT, errorPageSource(404)), second);
    expect(await (await missingPage())?.text()).toBe(second);
  });

  test('a 500 is the overlay even when the app wrote a 500 page', async () => {
    await Bun.write(join(ROOT, errorPageSource(500)), '<!doctype html><h1>We broke it</h1>');
    running = await startWebRole(true);
    const response = await browserGet('/boom');
    expect(response?.status).toBe(500);
    const body = (await response?.text()) ?? '';
    expect(body).toContain(SECRET);
    expect(body).not.toContain('We broke it');
  });
});
