// What a container loads, as a build error. `@ultimat3/cli/serve` is the one import an app's
// `apps/web/server.ts` makes, and its module graph must carry nothing that exists for development
// or tests: `@ultimat3/testing` (38 modules rode in through the live replicator until it moved to
// `@ultimat3/realtime/server`), the CLI's scaffold templates, the e2e driver, the CDP browser.
// The barrel it replaced was 1,349 modules.
//
// Pinned PER ROLE, because a role imports what it runs: the static graph is what `ROLE=migrate`
// evaluates, `serve-boot.ts` is what every serving role adds behind `serveApp`'s one
// `await import()`, `serve-web.ts` is what `ROLE=web` adds behind one more, and
// everything else reachable is loaded on first use (Babel when an image has no prebuilt store,
// `nats` when the app's transport is NATS, the admin mount when the app declares one, the manifest
// projection when `BUILD_ID` is unstamped).

import { describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove; the metafile needs a scratch directory.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; the child's argv takes paths already joined.
import { join } from 'node:path';
import { exec } from './exec';

/** Never a production module: a harness, a generator's text, a browser driver. */
/** A path, not the package name: a `bun -e` script resolves a bare specifier from no file. */
import { MIGRATE_CEILING, SERVING_ROLE_CEILING } from './serve-graph-ceilings-fixture';
import { WEB_ROLE_CEILING } from './serve-graph-web-ceiling-fixture';

const RENDER_SERVER = Bun.fileURLToPath(import.meta.resolve('@ultimat3/render/server'));

const FORBIDDEN = /packages\/testing\/|packages\/cli\/src\/templates\/|\/e2e-|\/cdp-/;

/**
 * What only a process that serves documents evaluates. In the static graph these were 107 modules
 * every worker, scheduler and migrate pod loaded to render nothing (966 static, 2026-10-01).
 */
// `admin/src/{audit,error-groups}-schema.ts`, `auth/src/authorization-server-schema.ts`,
// `auth/src/tables.ts`, `mcp/src/confirmation-schema.ts` and
// `pwa/src/push-schema.ts` are schema leaves every role may load: `FRAMEWORK_SCHEMA` applies their
// DDL through the packages' `./schema` exports without evaluating the auth runtime barrel.
const WEB_ONLY =
  /packages\/pwa\/src\/(?!push-schema\.ts$)|packages\/(?:manifest|ui)\/src\/|packages\/mcp\/src\/(?!confirmation-schema\.ts$)|packages\/admin\/src\/(?!(?:audit|error-groups)-schema\.ts$)|packages\/cli\/src\/(?:serve-web|runtime-render|island-|sw-|pwa-|seo-routes|page-)/;

/**
 * What no role evaluates at boot, whatever the app: reachable only behind an `await import()` at
 * its point of use, or not from this entry at all. Each line was once in every role's graph.
 */
const NEVER_AT_BOOT: readonly (readonly [string, RegExp])[] = [
  // 66 vendor modules, ~545 kB of source, loaded by every app with realtime on or off — until
  // `@ultimat3/realtime/server` put the adapter behind `nats-open.ts`. Opened when `NATS_URL` is
  // set.
  ['the nats client', /\/node_modules\/(?:nats|nkeys\.js|tweetnacl)\//],
  // Ten modules only `x db gen`, `x db migrate` and the gate's `drift` step call; they rode
  // `@ultimat3/db`'s barrel until they moved to `@ultimat3/db/schema-dump`.
  [
    'the schema-dump family',
    /packages\/db\/src\/(?:catalog(?:-fold|-objects|-relations)?|dump-drift|introspect-catalog|object-drift|schema-dump(?:-table|-entry)?|schema-load)\.ts$/,
  ],
  // Five modules only `x db diagnostics` calls, on `@ultimat3/db/diagnostics` from the day they
  // landed: on the barrel every role evaluated them to serve nothing.
  [
    'the diagnostics family',
    /packages\/db\/src\/(?:db-diagnostics(?:-deadline|-redact|-rows|-sql)?|diagnostics-entry)\.ts$/,
  ],
  // The island builder and its compiler: an image is prebuilt, and a boot that is not loads them
  // through `island-store.ts`'s own import — in the web role, never in a worker.
  ['Babel', /\/node_modules\/@babel\//],
];

interface MetaInput {
  readonly imports: readonly { readonly path: string; readonly kind: string }[];
}

/** Every module evaluated when `roots` are: static edges only — an `await import()` is a choice. */
function evaluatedWith(
  inputs: Readonly<Record<string, MetaInput>>,
  roots: readonly string[],
): readonly string[] {
  const seen = new Set<string>(roots);
  const stack = [...roots];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    for (const edge of inputs[current]?.imports ?? []) {
      if (edge.kind === 'dynamic-import' || seen.has(edge.path)) continue;
      if (inputs[edge.path] === undefined) continue;
      seen.add(edge.path);
      stack.push(edge.path);
    }
  }
  return [...seen];
}

describe('the @ultimat3/cli/serve module graph', () => {
  test('carries no test, template, e2e or cdp module, and each role stays under its pin', async () => {
    // A child build, never `Bun.build` in this process: the test preload installs plugins that
    // change what resolves, and the graph under test is the one a plain build sees. Plain but for
    // the server `.tsx` transform, which every graph that loads a component carries: without it Bun
    // 1.4.3 refuses the build (`No matching export … for import "jsxDEV"`, issue #883). Its
    // prelude's one edge per `.tsx` is the edge the runtime loader gives that file.
    const dir = mkdtempSync(join(tmpdir(), 'serve-graph-'));
    const meta = join(dir, 'meta.json');
    const script = [
      `const { serverTsxBuildPlugin } = await import(${JSON.stringify(RENDER_SERVER)});`,
      'const built = await Bun.build({',
      `  entrypoints: [${JSON.stringify(join(import.meta.dir, 'serve-entry.ts'))}],`,
      "  target: 'bun',",
      `  outdir: ${JSON.stringify(join(dir, 'out'))},`,
      '  metafile: true,',
      '  plugins: [serverTsxBuildPlugin],',
      '  throw: false,',
      '});',
      'if (!built.success) { console.error(built.logs.map(String).join("\\n")); process.exit(1); }',
      `await Bun.write(${JSON.stringify(meta)}, JSON.stringify(built.metafile));`,
    ].join('\n');
    // Awaited through the CLI's one subprocess boundary, never `Bun.spawnSync`: a synchronous wait
    // holds the test worker's only thread, so a build that does not come back is a worker the
    // test timeout cannot end.
    const child = await exec([process.execPath, '-e', script], { cwd: process.cwd() });
    expect([child.code, child.stderr.slice(0, 400)]).toEqual([0, '']);
    const { inputs } = (await Bun.file(meta).json()) as {
      inputs: Readonly<Record<string, MetaInput>>;
    };
    rmSync(dir, { recursive: true, force: true });
    const all = Object.keys(inputs);
    const named = (suffix: string): string => all.find((path) => path.endsWith(suffix)) ?? '';
    const entry = named('packages/cli/src/serve-entry.ts');
    // What `serveApp` imports for every role but `migrate`, and what the web role adds to it.
    const serving = [entry, named('packages/cli/src/serve-boot.ts')];
    const webEntry = named('packages/cli/src/serve-web.ts');
    // Non-vacuity: a build that answered no metafile, or one that lost an entry, would pass every
    // assertion below.
    expect(all.length).toBeGreaterThan(100);
    expect([...serving, webEntry]).not.toContain('');
    // Everything reachable, lazily or not: a forbidden module behind `await import()` still ships.
    expect(all.filter((path) => FORBIDDEN.test(path))).toEqual([]);

    const migrate = evaluatedWith(inputs, [entry]);
    const everyRole = evaluatedWith(inputs, serving);
    const web = evaluatedWith(inputs, [...serving, webEntry]);
    console.info(
      `serve graph modules: migrate=${migrate.length}, serving=${everyRole.length}, web=${web.length}`,
    );
    // `ROLE=migrate` applies SQL files and exits: it boots no service and no role.
    expect(
      migrate.filter((path) => /cli\/src\/(?:runtime-services|serve-boot|role-)/.test(path)),
    ).toEqual([]);
    // Exact membership also fails if the auth DDL leaves disappear: no vacuous exclusion check.
    expect(
      migrate
        .filter((path) => /packages\/auth\/src\//.test(path))
        .map((path) => path.slice(path.indexOf('packages/auth/src/')))
        .sort(),
    ).toEqual(['packages/auth/src/authorization-server-schema.ts', 'packages/auth/src/tables.ts']);
    expect(migrate.length).toBeLessThanOrEqual(MIGRATE_CEILING);

    // The property per-role loading rests on: the web surface is a CHOICE of the boot. One static
    // import of `serve-web.ts`, or of anything only it needs, puts it back in every role.
    expect(everyRole.filter((path) => WEB_ONLY.test(path))).toEqual([]);
    expect(everyRole.length).toBeGreaterThan(migrate.length);
    expect(everyRole.length).toBeLessThanOrEqual(SERVING_ROLE_CEILING);

    expect(web.length).toBeGreaterThan(everyRole.length);
    expect(web.length).toBeLessThanOrEqual(WEB_ROLE_CEILING);

    // The web role's graph is the widest: clean there is clean in every role.
    for (const [name, pattern] of NEVER_AT_BOOT) {
      expect([name, web.filter((path) => pattern.test(path))]).toEqual([name, []]);
    }
    // And each one still SHIPS — reachable behind its `await import()` — except the schema-dump
    // family, which a container never calls at all.
    expect(all.some((path) => /\/node_modules\/nats\//.test(path))).toBe(true);
    expect(all.some((path) => /\/node_modules\/@babel\//.test(path))).toBe(true);
  }, 60_000);
});
