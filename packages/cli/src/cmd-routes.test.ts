// `x routes` had no test at all, which is how `--surface App` came to report `0 routes` and exit 0
// — the same output an app with no routes gives. What is asserted here is the filter's closed set,
// that the refusal lands before the app is loaded, and the two projections of one route table.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RouteDescriptor } from '@ultimat3/render';
import { clearRoutes, defineRoute, registerRoute, SURFACES } from '@ultimat3/render';
import { readSurfaceFilter, renderRouteTable, routesCommand } from './cmd-routes';
import type { CommandContext } from './command';
import { parseArgs } from './parse';
import { SPECS } from './registry';

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'x-routes-'));
  writeFileSync(join(root, 'app.config.ts'), 'export const config = {};\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const contextFor = (argv: readonly string[]): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd: root,
  // `x routes` reads registries; a subprocess from it is the bug, not a fixture.
  runner: (command) => {
    throw new Error(`x routes spawned ${command.join(' ')}`);
  },
  env: {},
  bunVersion: '1.3.0',
});

const descriptor = (overrides: Partial<RouteDescriptor>): RouteDescriptor =>
  ({
    path: '/pricing',
    surface: 'site',
    mode: 'static',
    hydrate: 'never',
    offline: 'none',
    file: 'apps/web/site/pricing/page.tsx',
    ...overrides,
  }) as RouteDescriptor;

describe('unit · x routes --surface is a closed set', () => {
  // The bug in one line: `route.surface === surface` is true for nothing when `surface` is not a
  // surface, and "nothing matched" renders identically to "this app declares no routes".
  test('a value that is not a surface is refused, never reported as zero routes', async () => {
    for (const raw of ['App', 'pages', 'Site', 'apps', '']) {
      const thrown: unknown = await routesCommand
        .run(contextFor(['routes', '--surface', raw]))
        .then(
          (result) => result,
          (error: unknown) => error,
        );
      expect([raw, (thrown as { code?: string }).code]).toEqual([raw, 'X_CLI_BAD_FLAG']);
      expect([raw, (thrown as { cause: string }).cause]).toEqual([
        raw,
        `--surface on "x routes": "${raw}" is not a surface (known: site, app, api, shared)`,
      ]);
      expect([raw, (thrown as { fix: string }).fix]).toEqual([
        raw,
        'x routes --surface app --json',
      ]);
    }
  });

  // Not the two `x g --surface` takes: a route's surface comes from its own path, so `api` is a
  // filter that has to keep working, and the set is render's own rather than a copy of it.
  test('every surface the framework declares is accepted', () => {
    expect(SURFACES).toEqual(['site', 'app', 'api', 'shared']);
    for (const surface of SURFACES) expect(readSurfaceFilter(surface)).toBe(surface);
    expect(readSurfaceFilter(undefined)).toBeUndefined();
  });

  test('a valid surface with no routes is still an answer, not a refusal', async () => {
    const result = await routesCommand.run(contextFor(['routes', '--surface', 'api', '--json']));
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ routes: [] });
  });
});

describe('unit · the route table renders one row per route', () => {
  test('the header and every column are fixed-width and aligned', () => {
    const lines = renderRouteTable([
      descriptor({}),
      descriptor({ path: '/dashboard', surface: 'app', file: 'apps/web/app/dashboard/page.tsx' }),
    ]);
    expect(lines[0]?.startsWith('path')).toBe(true);
    // One width per column, computed across every row: two rows of one table have one length.
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
    expect(lines[1]).toContain('/pricing');
    expect(lines[2]).toContain('/dashboard');
  });
});

// The `--json` projection, which had no coverage at all: the terminal table and the JSON payload
// are two views of ONE route table, and only one of them is what an agent reads.
describe('unit · x routes --json projects every fact the table shows', () => {
  // `defineRoute`, not a literal: `registerRoute` refuses a raw declaration.
  const site = defineRoute({
    render: 'static',
    hydrate: 'never',
    offline: 'precache',
    budget: { js: '0kb', lcp: 1500 },
    meta: () => ({ title: 'Home', description: 'the landing page' }),
  });
  const app = defineRoute({
    render: 'stream',
    hydrate: 'visible',
    offline: 'runtime',
    policy: { permission: 'dashboard:read' },
    budget: { js: '60kb', lcp: 2500 },
    meta: () => ({ title: 'Dashboard', description: 'authed' }),
  });

  beforeEach(() => {
    clearRoutes();
  });

  afterEach(() => {
    clearRoutes();
  });

  test('each row carries its path, surface, file, mode, hydrate, offline and budget', async () => {
    registerRoute({ file: 'apps/web/site/page.tsx', config: site });
    const result = await routesCommand.run(contextFor(['routes', '--json']));
    expect(result.data).toEqual({
      routes: [
        {
          path: '/',
          surface: 'site',
          file: 'apps/web/site/page.tsx',
          render: 'static',
          hydrate: 'never',
          offline: 'precache',
          budget: { js: '0kb', lcp: 1500 },
        },
      ],
    });
  });

  test('the JSON rows and the printed rows are the same routes, filtered the same way', async () => {
    registerRoute({ file: 'apps/web/site/page.tsx', config: site });
    registerRoute({
      file: 'apps/web/app/dashboard/page.tsx',
      config: app,
      suspenseBoundaries: 1,
    });

    const all = await routesCommand.run(contextFor(['routes', '--json']));
    const rows = (all.data as { routes: readonly { path: string }[] }).routes;
    expect(rows.map((row) => row.path).sort()).toEqual(['/', '/dashboard']);
    // One printed line per route, plus the header.
    expect(all.lines).toHaveLength(rows.length + 1);
    expect(all.summary).toContain('2');

    const filtered = await routesCommand.run(contextFor(['routes', '--surface', 'app', '--json']));
    const appRows = (filtered.data as { routes: readonly { path: string }[] }).routes;
    expect(appRows.map((row) => row.path)).toEqual(['/dashboard']);
  });
});
