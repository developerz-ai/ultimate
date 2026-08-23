// Single responsibility: the `script-src` the web role sends, against the scripts that same
// response carries. The sibling of `dev-roles-csp.test.ts`, and split from it for the same reason
// — this asks whether ONE response's policy admits ONE response's inline script.
//
// The bug it pins: `script-src` was `'self' 'wasm-unsafe-eval'` while every document carrying an
// island shipped the hydration runtime as an inline `<script type="module">`. `x dev` sends the
// policy report-only, so the page hydrated on a laptop and no island booted in any container —
// the one deployment where the policy is enforced.

import { afterEach, describe, expect, test } from 'bun:test';
import { cspHashSource } from '@ultimat3/http';
import { clearRoutes, defineRoute, island, registerRoute } from '@ultimat3/render';
import { appRoutes } from './dev-render';
import type { RunningRoles } from './dev-roles';
import { selectRoles, startRoles } from './dev-roles';
import { fixtureRuntime, resetDevRolesState } from './dev-roles-fixture';

const ROOT = `${import.meta.dir}/../.roles-script-csp-fixture`;

let running: RunningRoles | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  resetDevRolesState();
  clearRoutes();
});

const Widget = island({ src: './widget.island.tsx' });

/**
 * Every inline script in the document that no source in the policy names. A `src=` element is
 * governed by the host sources and carries no body to hash; a `type` ending in `json` is a DATA
 * block, which the HTML spec never prepares as a script, so no browser asks the policy about it.
 */
const uncovered = (body: string, csp: string): readonly string[] =>
  [...body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([, attrs = '']) => !/\bsrc=/.test(attrs) && !/\btype="[^"]*json"/.test(attrs))
    .map(([, , script = '']) => script)
    .filter((script) => script.length > 0 && !csp.includes(cspHashSource(script)));

const serve = async (): Promise<Response> => {
  running = await startRoles({
    roles: selectRoles('web'),
    port: 0,
    buildId: 'test',
    runtime: fixtureRuntime(ROOT),
    env: {},
    routes: appRoutes({
      buildId: 'test',
      // No bundle: the URL the runtime imports is not what this file asks about, and building one
      // would make a policy test depend on a bundler.
      resolveIsland: () => () => '/islands/widget-00000000.js',
    }),
    // A container's binding. `dev: false` is the whole question: it is what turns the policy from
    // report-only into the enforced one, and the enforced one is the only one that can block.
    http: { dev: false, hostname: 'localhost' },
  });
  const response = await running.server?.fetch(new Request('http://dev.test/'));
  if (response === undefined) expect.unreachable('the web role answered nothing');
  return response;
};

describe('the CSP the web role sends admits the scripts it serves', () => {
  test('an island page is covered by the enforced policy the same response carries', async () => {
    registerRoute({
      file: 'apps/web/site/page.tsx',
      config: defineRoute<{ url: string; params: Record<string, string> }>({
        render: 'ssr',
        offline: 'network-only',
        hydrate: 'idle',
        budget: { js: '20kb' },
        meta: () => ({ title: 'island', description: 'island' }),
      }),
      component: () => Widget({ children: 'inert' }),
    });

    const response = await serve();
    const body = await response.text();
    const csp = response.headers.get('content-security-policy') ?? '';

    // The document really does carry the runtime — without this the assertion below is vacuous.
    expect(body).toContain('<script type="module">');
    expect(body).toContain('requestIdleCallback');
    expect(csp).not.toContain("script-src 'self' 'wasm-unsafe-eval';");
    expect(uncovered(body, csp)).toEqual([]);
  });

  test('the runtime for every strategy is admitted, not just the one this route needs', async () => {
    registerRoute({
      file: 'apps/web/site/page.tsx',
      config: defineRoute<{ url: string; params: Record<string, string> }>({
        render: 'ssr',
        offline: 'network-only',
        hydrate: 'interaction',
        budget: { js: '20kb' },
        meta: () => ({ title: 'island', description: 'island' }),
      }),
      component: () => Widget({ children: 'inert' }),
    });

    const response = await serve();
    const csp = response.headers.get('content-security-policy') ?? '';
    // A policy computed from the route table would cover this page and block the next deploy's.
    expect(uncovered(await response.text(), csp)).toEqual([]);
  });
});
