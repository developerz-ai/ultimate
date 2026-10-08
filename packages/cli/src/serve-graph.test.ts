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
// `admin/src/audit-schema.ts`, `mcp/src/confirmation-schema.ts` and `pwa/src/push-schema.ts` are
// the one admin, mcp and pwa module every role may load: the leaves the boot's `FRAMEWORK_SCHEMA`
// applies `x_admin_audit`, `x_mcp_confirmations` and `x_push_subscriptions` from, reached as
// `@ultimat3/admin/schema`, `@ultimat3/mcp/schema` and `@ultimat3/pwa/schema`.
const WEB_ONLY =
  /packages\/pwa\/src\/(?!push-schema\.ts$)|packages\/(?:manifest|ui)\/src\/|packages\/mcp\/src\/(?!confirmation-schema\.ts$)|packages\/admin\/src\/(?!audit-schema\.ts$)|packages\/cli\/src\/(?:serve-web|runtime-render|island-|sw-|pwa-|seo-routes|page-)/;

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
 * raised 615 → 620, measured 620 (2026-10-06, plan 101 sweep 10b): the modules named on
 * `SERVING_ROLE_CEILING` for sweep 10b that `ROLE=migrate` reaches through the db and entity
 * barrels — the append-only trigger it must create and the drift check that refuses a missing one.
 * raised 620 → 622, measured 622 (2026-10-06, plan 101 sweep 10c): `mcp/src/confirmation-schema.ts`
 * (the leaf `@ultimat3/mcp/schema` the boot applies `x_mcp_confirmations` from) and
 * `http/src/request-facts.ts` (the one request-facts builder mcp and the bearer mount share).
 * raised 622 → 623, measured 623 (2026-10-06, plan 101 sweep 10d): `core/src/config-mail.ts` — the
 * `mail.retainMime` app-config key, validated where every config section is.
 * raised 623 → 624, measured 624 (2026-10-06, plan 101 sweep 11): `schema/src/unstorable-text.ts`
 * — the one NUL/lone-surrogate predicate `t.json()` and now every string builtin share (a lone
 * surrogate was a jsonb 500 and a silent U+FFFD on text), split out of `validators.ts` at 486 lines.
 * raised 624 → 625, measured 625 (2026-10-07, plan 101 sweep 12c): `core/src/config-jobs.ts` — the
 * per-queue `jobs.concurrency` table (#676), validated where every config section is.
 * raised 625 → 628, measured 628 (2026-10-07, sweep 13a): `schema/src/array-schema.ts` (array
 * item-count bounds, split out of `validators.ts` at 484 lines), `db/src/db-executor.ts` (the one
 * `PgExecutor` builder, #688) and `cache/src/value-codec.ts` (one value shape on every cache tier).
 * raised 628 → 629, measured 629 (2026-10-07, sweep 13b): `jobs/src/errors-tenant.ts` — the terminal
 * `X_JOB_TENANT_MISMATCH` a webhook delivery or a queued agent refuses a wrong org with.
 * raised 629 → 630, measured 630 (2026-10-07, sweep 14): `entity/src/transition-pins.ts` — the
 * columns a transition's policy read, pinned into its compare-and-set (#702).
 * raised 630 → 631, measured 631 (2026-10-07, 26.0.0 app feedback): `core/src/log-tee.ts` — `addLogSink`,
 * the supported log tee, reached through `logger.ts` by every module that logs.
 * raised 631 → 632, measured 632 (2026-10-08, Web Push): `pwa/src/push-schema.ts` — the leaf
 * `@ultimat3/pwa/schema` the boot applies `x_push_subscriptions` from, as the mcp leaf above.
 */
const MIGRATE_CEILING = 632;

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
 * raised 887 → 888, measured 888 (2026-10-05, plan 101 sweep 8b, native Windows): `cli/src/posix-path.ts`
 * (`app-load` sorts module paths by their `/` form, so every OS imports an app in one order) and
 * `core/src/bunfs.ts` (`isCompiledBundle`, the Windows `B:\~BUN\` prefix beside `/$bunfs/`), against
 * sweep 7's 886.
 * raised 888 → 893, measured 893 (2026-10-05, plan 101 sweep 8c, zero-downtime deploys): a worker
 * that lets a running job FINISH on SIGTERM — `jobs/src/worker-drain-cutoff.ts` (cancel only at
 * the deadline less a margin), `worker-held.ts` (hand every held claim back before the driver
 * closes), `worker-tally.ts` (counters split so `worker.ts` stays under the ceiling) — plus
 * `core/src/drain-deadline.ts` (`drain.deadlineMs`) and `db/src/migrate-rollback.ts` (a rollback
 * onto a newer build's ledger is accepted, not `X_MIGRATION_CONFLICT`).
 * raised 893 → 894, measured 894 (2026-10-05, plan 101 sweep 9, #506): `render/src/island-hold.ts`
 * — a realtime island on a page-boot document is held hidden until every held island has mounted
 * over the restored store and outbox, so an offline reload never paints the stale count first.
 * raised 894 → 900, measured 900 (2026-10-06, plan 101 sweep 10a): `schema/src/json-value.ts`
 * (`t.json()`), `core/src/aws-sigv4.ts` (the one SigV4 signer), and S3 Object Lock in storage —
 * `object-lock.ts`, `driver-s3-signed.ts` (the signed PUT a locked or metadata-carrying put takes),
 * `driver-s3-lock.ts` (its headers and the retention reads) and `driver-s3-client.ts` (moved out so
 * `driver-s3.ts` stays under the ceiling).
 * raised 900 → 907, measured 907 (2026-10-06, plan 101 sweep 10b): `entity({ appendOnly: true })` —
 * `entity/src/append-only.ts`, `append-only-errors.ts`, `db/src/generate-append-only.ts` (the
 * trigger) and `drift-append-only.ts` (a missing trigger is drift); audited reads —
 * `core/src/audit.ts` (the one audit contract action and query share), `query/src/audit-gate.ts`
 * and `audit-errors.ts`.
 * raised 907 → 912, measured 912 (2026-10-06, plan 101 sweep 10c): the two named on
 * `MIGRATE_CEILING` for 10c, and the SES transport a worker sends mail through —
 * `mail/src/driver-ses.ts`, `ses-failure.ts` (SES error types onto retry classes) and
 * `retain-mime.ts`. The SNS/Resend receivers stay off every role, behind `@ultimat3/mail/events`.
 * raised 912 → 914, measured 914 (2026-10-06, plan 101 sweep 10d): `core/src/config-mail.ts` (named
 * on `MIGRATE_CEILING`) and `cli/src/runtime-mail.ts`, which hands that key to the mail driver a
 * worker sends through.
 * raised 914 → 917, measured 917 (2026-10-06, plan 101 sweep 11): the module named on
 * `MIGRATE_CEILING` for 11, `realtime/src/sync-bus-handlers.ts` (the bus handlers, moved out so
 * `sync-node.ts` stays under the ceiling once `start()` is memoised and `stop()` waits it out), and
 * `storage/src/driver-memory-conflict.ts` (the memory disk refusing the key conflicts local does).
 * raised 917 → 918, measured 918 (2026-10-06, plan 101 sweep 11b): `realtime/src/nats-subscriptions.ts`
 * — the kept subscription list a `NatsTransport` re-binds once the library has closed its client for
 * good, which left every realtime role dead until a manual restart.
 * raised 918 → 920, measured 920 (2026-10-07, plan 101 sweep 12c): the module named on
 * `MIGRATE_CEILING` for 12c, and `realtime/src/record-publisher.ts` — committed rows published as
 * channel records with no replicator (#682), which the `x dev` bridge reads to skip a claimed table.
 * raised 920 → 923, measured 923 (2026-10-07, sweep 13a): the three modules named on
 * `MIGRATE_CEILING` for 13a, reached through the same db, schema and cache barrels.
 * raised 923 → 924, measured 924 (2026-10-07, sweep 13b): `jobs/src/errors-tenant.ts` — the terminal
 * `X_JOB_TENANT_MISMATCH` a webhook delivery or a queued agent refuses a wrong org with.
 * raised 924 → 925, measured 925 (2026-10-07, sweep 14): `entity/src/transition-pins.ts` — the
 * columns a transition's policy read, pinned into its compare-and-set (#702).
 * raised 925 → 926, measured 926 (2026-10-07, 26.0.0 app feedback): `core/src/log-tee.ts` — `addLogSink`,
 * the supported log tee, reached through `logger.ts` by every module that logs.
 * raised 926 → 927, measured 927 (2026-10-08, 26.1.0 route-presented modals):
 * `render/src/navigation-modal-rules.ts` — `NAVIGATION_PRESENTATION_META`, the meta a
 * `navigation: 'modal'` document names, reached through `navigation-tags.ts` by the render barrel.
 * raised 927 → 929, measured 929 (2026-10-08, Web Push): the leaf named on `MIGRATE_CEILING`, and
 * `cli/src/runtime-push.ts` — `pwa.push` read and its VAPID pair resolved before the queue starts;
 * `@ultimat3/pwa` itself stays behind its `await import()`.
 */
const SERVING_ROLE_CEILING = 929;

/**
 * measured: 888 — the 796 above plus the 92 `serve-web.ts` adds (41 CLI, 36 MCP, 15 PWA).
 * raised 975 → 980, measured 980 (2026-10-05, plan 101 sweep 1c): the same five modules named on
 * `SERVING_ROLE_CEILING`, which every role carries.
 * raised 980 → 982, measured 982 (2026-10-05, plan 101 sweep 2): the same two modules named on
 * `SERVING_ROLE_CEILING` for sweep 2.
 * raised 982 → 984, measured 984 (2026-10-05, plan 101 sweep 7): `core/src/metrics.ts` hit the
 * 500-line ceiling and split by responsibility into `metric-errors.ts`, `metric-registry.ts` and
 * `metric-series.ts` (+3), and `storage/src/driver-s3-absent.ts` left `driver-s3.ts` (+1); the
 * action and query `deprecation.ts` copies collapsed into one `core/src/deprecation.ts` (−1 net).
 * raised 984 → 987, measured 987 (2026-10-05, plan 101 sweep 8b, native Windows): the two modules
 * named on `SERVING_ROLE_CEILING` for sweep 8b, and `cli/src/island-package-dedupe.ts` — the island
 * build resolves every `@ultimat3/*` import to the app's one copy, which a Windows `file:` install
 * without symlinks had bundled twice (+15 KB on `/posts`).
 * raised 987 → 992, measured 992 (2026-10-05, plan 101 sweep 8c): the five modules named on
 * `SERVING_ROLE_CEILING` for sweep 8c.
 * raised 992 → 994, measured 994 (2026-10-05, plan 101 sweep 9): `render/src/island-hold.ts` (named on
 * `SERVING_ROLE_CEILING`, #506) and `cli/src/island-runtime.ts` (#505: the page runtime built once
 * per page instead of inlined into every realtime island; split out so `island-bundle.ts` stays
 * under the ceiling).
 * raised 994 → 998, measured 998 (2026-10-05, plan 101 sweep 9b): `cli/src/theme-brand.ts` (the one
 * reader of an app's `apps/web/shared/theme.ts` brand, inlined with its CSP hash), and the island
 * build's duplicate-module guard — `island-duplicates.ts` (detection), `island-duplicate-refusal.ts`
 * (refuse a framework duplicate, warn on a third-party one) and `island-entry-missing.ts` (the
 * refusals moved out so `island-bundle.ts` stays under the 500-line ceiling).
 * raised 998 → 1004, measured 1004 (2026-10-06, plan 101 sweep 10a): the six modules named on
 * `SERVING_ROLE_CEILING` for sweep 10a.
 * raised 1004 → 1011, measured 1011 (2026-10-06, plan 101 sweep 10b): the seven modules named on
 * `SERVING_ROLE_CEILING` for sweep 10b.
 * raised 1011 → 1024, measured 1024 (2026-10-06, plan 101 sweep 10c): the five named on
 * `SERVING_ROLE_CEILING` for 10c, MCP human confirmation and its audit hook on the web role —
 * `mcp/src/confirmations.ts`, `confirmation-gate.ts`, `confirmation-store.ts`,
 * `confirmation-postgres.ts`, `confirmation-errors.ts`, `audit-hook.ts`, `confirmation-decide.ts` (an approval
 * must carry back the exact arguments `view` showed, compared by keyed digest) — and
 * `mcp/src/errors-transport.ts`, the transport error classes split out so `errors.ts` stays under
 * the 500-line ceiling once the eight confirmation codes are registered.
 * raised 1024 → 1026, measured 1026 (2026-10-06, plan 101 sweep 10d): the two modules named on
 * `SERVING_ROLE_CEILING` for 10d (`admin/src/mcp-scopes.ts` is behind the admin mount's lazy import).
 * raised 1026 → 1029, measured 1029 (2026-10-06, plan 101 sweep 11): the three modules named on
 * `SERVING_ROLE_CEILING` for 11.
 * raised 1029 → 1030, measured 1030 (2026-10-06, plan 101 sweep 11b): `realtime/src/nats-subscriptions.ts`,
 * named on `SERVING_ROLE_CEILING` for 11b.
 * raised 1030 → 1032, measured 1032 (2026-10-07, plan 101 sweep 12c): the two modules named on
 * `SERVING_ROLE_CEILING` for 12c.
 * raised 1032 → 1035, measured 1035 (2026-10-07, sweep 13a): the three modules named on
 * `MIGRATE_CEILING` for 13a — the web role reaches every module the serving roles do.
 * raised 1035 → 1036, measured 1036 (2026-10-07, sweep 13b): `jobs/src/errors-tenant.ts` — the terminal
 * `X_JOB_TENANT_MISMATCH` a webhook delivery or a queued agent refuses a wrong org with.
 * raised 1036 → 1037, measured 1037 (2026-10-07, sweep 14): `entity/src/transition-pins.ts` — the
 * columns a transition's policy read, pinned into its compare-and-set (#702).
 * raised 1037 → 1038, measured 1038 (2026-10-07, 26.0.0 app feedback): `core/src/log-tee.ts` — `addLogSink`,
 * the supported log tee, reached through `logger.ts` by every module that logs.
 * raised 1038 → 1039, measured 1039 (2026-10-08, 26.1.0): the module named on
 * `SERVING_ROLE_CEILING` for route-presented modals.
 * raised 1039 → 1053, measured 1053 (2026-10-08, Web Push): the two modules named on
 * `SERVING_ROLE_CEILING`, and the twelve the `@ultimat3/pwa` barrel the web role already loads now
 * carries — RFC 8291 encryption and its receiving half, the RFC 8292 signer and its key pair, the
 * sender, the runtime, the two stores, the subscribe actions and the client's meta name
 * (`installedVapid()` feeds `sw.js`'s push handler and `<meta name="x-push-key">`).
 * raised 1053 → 1054, measured 1054 (2026-10-08, 26.1.0 browser entry): `pwa/src/skew.ts` —
 * `detectSkew` and `AppUpdateAvailable`, split from `version-skew.ts` so `@ultimat3/pwa/client`
 * carries them without the error table; the web role reaches it through the pwa barrel.
 */
const WEB_ROLE_CEILING = 1054;

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
