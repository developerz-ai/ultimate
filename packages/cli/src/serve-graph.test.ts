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
const FORBIDDEN = /packages\/testing\/|packages\/cli\/src\/templates\/|\/e2e-|\/cdp-/;

/**
 * What only a process that serves documents evaluates. In the static graph these were 107 modules
 * every worker, scheduler and migrate pod loaded to render nothing (966 static, 2026-10-01).
 */
// `admin/src/audit-schema.ts` is the one admin module every role may load: the leaf the boot's
// `FRAMEWORK_SCHEMA` applies `x_admin_audit` from, reached as `@ultimat3/admin/schema`.
const WEB_ONLY =
  /packages\/(?:pwa|mcp|manifest|ui)\/src\/|packages\/admin\/src\/(?!audit-schema\.ts$)|packages\/cli\/src\/(?:serve-web|runtime-render|island-|sw-|pwa-|seo-routes|page-)/;

/**
 * What no role evaluates at boot, whatever the app: reachable only behind an `await import()` at
 * its point of use, or not from this entry at all. Each line was once in every role's graph.
 */
const NEVER_AT_BOOT: readonly (readonly [string, RegExp])[] = [
  // 66 vendor modules, ~545 kB of source, loaded by every app with realtime on or off — until
  // `@ultimat3/realtime/server` put the adapter behind `nats-open.ts`. Opened when an app's
  // `realtime.transport` is `'nats'`.
  ['the nats client', /\/node_modules\/(?:nats|nkeys\.js|tweetnacl)\//],
  // Ten modules only `x db gen`, `x db migrate` and the gate's `drift` step call; they rode
  // `@ultimat3/db`'s barrel until they moved to `@ultimat3/db/schema-dump`.
  [
    'the schema-dump family',
    /packages\/db\/src\/(?:catalog(?:-fold|-objects|-relations)?|dump-drift|introspect-catalog|object-drift|schema-dump(?:-table|-entry)?|schema-load)\.ts$/,
  ],
  // The island builder and its compiler: an image is prebuilt, and a boot that is not loads them
  // through `island-store.ts`'s own import — in the web role, never in a worker.
  ['Babel', /\/node_modules\/@babel\//],
];

/**
 * measured: 558 modules (`Bun.build` metafile, static edges from `serve-entry.ts`, 2026-10-01) —
 * 869 until the services and the role boot went behind `serveApp`'s `await import()`.
 * why: every ceiling here is the measurement plus 10%, so a real feature on the boot path fits and
 * a whole subsystem arriving does not. Raise one with the new measured number in the same diff.
 */
const MIGRATE_CEILING = 615;

/**
 * measured: 796 — the 558 above plus what `serve-boot.ts` adds: the services and the roles.
 * raised 875 → 880, measured 880 (2026-10-04, plan 101 sweep 1): eight modules that are real function
 * on every role's path — the per-primitive rate-limit gates (`action/src/rate-limit-gate.ts`,
 * `query/src/rate-limit-gate.ts`), their shared header rendering and installed-limiter seam
 * (`http/src/rate-limit-headers.ts`, `http/src/rate-limit-installed.ts`), and the live-query
 * delivery split (`realtime/src/live-deliver.ts`, `live-spend.ts`, `socket-defaults.ts`), and
 * `cli/src/trusted-hops.ts`, moved out of `role-start.ts` so the sync role reads the same hop count.
 * raised 880 → 885, measured 885 (2026-10-05, plan 101 sweep 1c): the sync node's per-principal caps
 * (`realtime/src/subscription-count.ts`, `principal-sockets.ts`) and three splits the 500-line
 * ceiling forced (`live-reauth.ts` out of `live-query.ts`, `sync-actor-change.ts` out of
 * `sync-node.ts`, `db/src/migration-ledger.ts` out of `migrate.ts`).
 * raised 885 → 887, measured 887 (2026-10-05, plan 101 sweep 2): `action/src/idempotency-redact.ts`
 * (an idempotent answer redacted at rest, #591) and `jobs/src/webhook-attempt.ts` (the webhook
 * transport, split out so `webhook.ts` stays under the ceiling once the attempt carries its signal).
 */
const SERVING_ROLE_CEILING = 887;

/**
 * measured: 888 — the 796 above plus the 92 `serve-web.ts` adds (41 CLI, 36 MCP, 15 PWA).
 * raised 975 → 980, measured 980 (2026-10-05, plan 101 sweep 1c): the same five modules named on
 * `SERVING_ROLE_CEILING`, which every role carries.
 * raised 980 → 982, measured 982 (2026-10-05, plan 101 sweep 2): the same two modules named on
 * `SERVING_ROLE_CEILING` for sweep 2.
 */
const WEB_ROLE_CEILING = 982;

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
    // A child `bun build`, never `Bun.build` in this process: the test preload installs plugins
    // that change what resolves, and the graph under test is the one a plain build sees.
    const dir = mkdtempSync(join(tmpdir(), 'serve-graph-'));
    const meta = join(dir, 'meta.json');
    // Awaited through the CLI's one subprocess boundary, never `Bun.spawnSync`: a synchronous wait
    // holds the test worker's only thread, so a build that does not come back is a worker the
    // test timeout cannot end.
    const child = await exec(
      [
        process.execPath,
        'build',
        join(import.meta.dir, 'serve-entry.ts'),
        '--target=bun',
        `--outdir=${join(dir, 'out')}`,
        `--metafile=${meta}`,
      ],
      { cwd: process.cwd() },
    );
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
    // `ROLE=migrate` applies SQL files and exits: it boots no service and no role.
    expect(
      migrate.filter((path) => /cli\/src\/(?:runtime-services|serve-boot|role-)/.test(path)),
    ).toEqual([]);
    expect(migrate.length).toBeLessThanOrEqual(MIGRATE_CEILING);

    const everyRole = evaluatedWith(inputs, serving);
    // The property per-role loading rests on: the web surface is a CHOICE of the boot. One static
    // import of `serve-web.ts`, or of anything only it needs, puts it back in every role.
    expect(everyRole.filter((path) => WEB_ONLY.test(path))).toEqual([]);
    expect(everyRole.length).toBeGreaterThan(migrate.length);
    expect(everyRole.length).toBeLessThanOrEqual(SERVING_ROLE_CEILING);

    const web = evaluatedWith(inputs, [...serving, webEntry]);
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
