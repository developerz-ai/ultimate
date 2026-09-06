// Single responsibility: the `style-src` the web role sends, against the styles that same response
// carries. Split from `dev-roles.test.ts` because it asks nothing about which roles start — it
// asks whether one started role's response is self-consistent.
//
// The bug it pins: the web role sent `style-src 'self'` and every document it served carried its
// surface's CSS in an inline `<style>`, so the browser parsed zero rules out of it and every
// deployed app rendered completely unstyled. A header-shaped unit test would not have caught it —
// the question is whether THIS response's policy admits THIS response's body.
//
// The surface CSS is a FILE now, so the same question has a second half: the `<link>` the document
// carries must be admitted too — by `'self'`, which is why the policy needs no hash for it — and
// the URL it names must actually be served by the same process.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
import { cspHashSource } from '@ultimat3/http';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { clearStylesheets, loadStylesheet } from '@ultimat3/render/server';
import { appRoutes } from './dev-render';
import type { RunningRoles } from './dev-roles';
import { selectRoles, startRoles } from './dev-roles';
import { fixtureRuntime, resetDevRolesState } from './dev-roles-fixture';
import { styleBundle } from './style-bundle';
import { styleRoutes } from './style-routes';

const ROOT = `${import.meta.dir}/../.roles-csp-fixture`;
const fakeRuntime = (): ReturnType<typeof fixtureRuntime> => fixtureRuntime(ROOT);

let running: RunningRoles | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  resetDevRolesState();
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('the CSP the web role sends admits the styles it serves', () => {
  /** Every `<style>` body in the document that no source in the policy names. */
  const uncovered = (body: string, csp: string): readonly string[] =>
    [...body.matchAll(/<style>([\s\S]*?)<\/style>/g)]
      .map((match) => match[1] ?? '')
      .filter((css) => !csp.includes(cspHashSource(css)));

  const page = (): void => {
    registerRoute({
      file: 'apps/web/site/page.tsx',
      suspenseBoundaries: 0,
      config: defineRoute<{ url: string; params: Record<string, string> }>({
        render: 'static',
        offline: 'network-only',
        hydrate: 'never',
        budget: { js: '0kb' },
        meta: () => ({ title: 'styled', description: 'styled' }),
      }),
    });
  };

  afterEach(() => {
    clearRoutes();
    clearStylesheets();
  });

  test('a page document is covered by the enforced policy the same response carries', async () => {
    loadStylesheet('/srv/demo/apps/web/site/page.module.scss', '.hero{color:red}');
    page();
    running = await startRoles({
      roles: selectRoles('web'),
      port: 0,
      buildId: 'test',
      runtime: fakeRuntime(),
      env: {},
      routes: [...styleRoutes(() => styleBundle()), ...appRoutes({ buildId: 'test' })],
      // A container's binding: `dev: false` is what turns the policy from report-only into the
      // enforced one, which is the only mode in which this failure is visible at all.
      http: { dev: false, hostname: 'localhost' },
    });

    const response = await running.server?.fetch(new Request('http://dev.test/'));
    const body = (await response?.text()) ?? '';
    const csp = response?.headers.get('content-security-policy') ?? '';

    // Nothing inline left to hash, and `'self'` is what admits the file — so the enforced policy
    // covers the document with NO style hash of its own.
    expect(uncovered(body, csp)).toEqual([]);
    expect(csp).toContain("style-src 'self'");
    const href = styleBundle().hrefFor('site') ?? '';
    expect(body).toContain(`href="${href}"`);

    // Same origin, same process: the URL the policy admits has to be one this server answers, or
    // `'self'` is admitting a 404.
    const sheet = await running.server?.fetch(new Request(`http://dev.test${href}`));
    expect(sheet?.status).toBe(200);
    expect(await sheet?.text()).toContain('color:red');
    expect(sheet?.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  test('a document the caller mounted itself is covered once it declares its style', async () => {
    page();
    running = await startRoles({
      roles: selectRoles('web'),
      port: 0,
      buildId: 'test',
      runtime: fakeRuntime(),
      env: {},
      routes: appRoutes({ buildId: 'test' }),
      http: { dev: false, hostname: 'localhost' },
      // What `x dev` passes for `/_x`: a body no stylesheet registry holds.
      inlineStyles: ['body{margin:0}'],
    });

    const csp =
      (await running.server?.fetch(new Request('http://dev.test/')))?.headers.get(
        'content-security-policy',
      ) ?? '';
    expect(uncovered('<style>body{margin:0}</style>', csp)).toEqual([]);
  });
});
