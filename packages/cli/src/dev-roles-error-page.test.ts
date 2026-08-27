// Which document a BROWSER gets from a started web role when the request fails. Split from
// `dev-roles.test.ts` for `dev-roles-csp.test.ts`'s reason: it asks nothing about which roles
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
import { clearRoutes } from '@ultimat3/render';
import { appRoutes } from './dev-render';
import type { RunningRoles } from './dev-roles';
import { selectRoles, startRoles } from './dev-roles';
import { fixtureRuntime, resetDevRolesState } from './dev-roles-fixture';
import { errorPageSource } from './error-pages';

const ROOT = join(import.meta.dir, '..', '.roles-error-page-fixture');

let running: RunningRoles | undefined;

const startWebRole = async (): Promise<RunningRoles> =>
  startRoles({
    roles: selectRoles('web'),
    port: 0,
    buildId: 'test',
    runtime: fixtureRuntime(ROOT),
    env: {},
    routes: appRoutes({ buildId: 'test' }),
    root: ROOT,
    // A container's binding: `dev: false` is the whole question — a dev process answers with the
    // overlay, which prints the cause, the fix and the stack.
    http: { dev: false, hostname: 'localhost' },
  });

const missingPage = async (): Promise<Response | undefined> =>
  running?.server?.fetch(new Request('http://dev.test/nope', { headers: { accept: 'text/html' } }));

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
