// `x dev` — the app, booted (`dev-boot.ts`), reported and held. Every role in one Bun process,
// embedded Postgres/events/storage started for real, and `@ultimat3/admin`'s `/_x` dashboard
// mounted alongside the app — mounted, never re-implemented — so an agent can introspect it.
// No Docker, no env setup: an unset variable means the embedded default.

import { join } from 'node:path';
import { METRICS_PATH } from '@ultimat3/core';
import { MANIFEST_FILENAME } from '@ultimat3/manifest';
import { requireAppRoot } from './app-root';
import { devSpec } from './cmd-dev-spec';
import type { CliCommand, CommandContext } from './command';
import { startDev } from './dev-boot';
import { clearLock, preflight, writeLock } from './dev-lock';
import { devPortFor } from './dev-port';
import { childRestart } from './dev-supervisor';
import { holdUntilShutdown } from './hold';
import { msg } from './messages';
import type { CommandResult } from './output';
import { flagString } from './parse';
import { DEV_BINDING, selectRoles } from './role-start';
import { describeServices, reportedUrls, resolveServices } from './runtime-bindings';
import { liveFeedLabel } from './runtime-live-feed';
import { cdnLabel, describeCdn, describeMail, mailLabel } from './runtime-services';
import { writeLine } from './write-line';

// The boot moved to `dev-boot.ts`; its names stay importable from here, where every caller and the
// package barrel already reach them.
export type { DevServer, StartDevOptions } from './dev-boot';
export { startDev } from './dev-boot';

export const devCommand: CliCommand = {
  spec: devSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('dev', ctx.cwd).dir;
    // Validated, not `parseInt`'d: `x dev --port abc` handed `NaN` to `Bun.serve`, which binds an
    // arbitrary port — a dev server reachable at an address nothing printed.
    const port = devPortFor(ctx.args, ctx.env);
    const roles = selectRoles(flagString(ctx.args, 'role'));
    // BEFORE anything boots. Both failures this catches were reachable and both reported the wrong
    // thing: a taken port surfaced as X_CLI_UNEXPECTED wrapping "Is port 3000 in use?" with a `fix:`
    // naming `x doctor`, and a second `x dev` on one checkout died later on X_DB_UNAVAILABLE whose
    // `fix:` named `x dev`. Neither is discoverable from the message; both are trivial once the
    // preflight has the state directory and the port in front of it.
    const services = resolveServices(root, ctx.env);
    const { clearedStale, release } = await preflight({
      stateDir: services.stateDir,
      port,
      // The address the web role will actually bind, never a wider one: probing `0.0.0.0` would
      // refuse a boot that a neighbour on one LAN interface does not actually block.
      hostname: DEV_BINDING.hostname,
      embeddedDb: services.db.mode === 'embedded',
    });
    // The directory is CLAIMED from here down, so a boot that throws has to give it back — the
    // `releaseBoot` shape, with one acquisition. Without it the first failed `x dev` in a shell
    // refuses every later one with a pid that is no longer running.
    const restart = childRestart(root, ctx.env);
    const server = await startDev({
      root,
      port,
      roles,
      env: ctx.env,
      onReload: (file, durationMs) => {
        if (!ctx.args.json) writeLine(msg('cli.dev.hmr', { file, ms: durationMs }));
      },
      // Supervised, a save this process cannot serve is a drain and an exit for a fresh child.
      ...restart.options,
    }).catch((error: unknown) => {
      release();
      throw error;
    });
    const result: CommandResult = {
      ok: server.findings.length === 0,
      command: 'dev',
      summary: msg('cli.dev.ready', {
        url: server.url,
        panels: server.panels.length,
        // Rendered text, so the mail and CDN halves come from the catalog; `data` below carries the
        // status values a script parses, which is why the two are different calls and not one.
        services: `${describeServices(server.services)} ${mailLabel(server.runtime)} ${cdnLabel(server.runtime)} ${liveFeedLabel(server.running.liveFeed)}`,
      }),
      findings: server.findings,
      // Every fact `lines` prints is a fact `--json` carries, `manifest` included — or the two
      // renderers have drifted and only one of them can be scripted against.
      data: {
        url: server.url,
        roles: [...server.roles],
        sync: server.running.syncUrl,
        // The scrape target, on its own port for every role: what an operator points a Prometheus
        // at, and the one url here that must NOT be behind the ingress the app's own url is.
        metrics: `${server.running.metricsUrl}${METRICS_PATH}`,
        stateDir: server.services.stateDir,
        // Redacted, for the reason the mail and cdn lines below already give and this line did
        // not: `DATABASE_URL`, `NATS_URL` and `S3_ENDPOINT` all carry a password, and this object
        // is printed, logged and scraped. `reportedUrls` is the one projection that may be shown.
        ...reportedUrls(server.services),
        // The selecting env key, never the credential behind it: `SMTP_URL` carries a password
        // and this line is printed, logged and scraped.
        mail: describeMail(server.runtime),
        cdn: describeCdn(server.runtime),
        // The slot this process holds, or null when the replicator was not selected. Two of these
        // on one database is the one topology mistake that cannot be seen from the outside, so the
        // slot is a scriptable fact rather than a line in a log.
        replicationSlot: server.running.replicator?.slot ?? null,
        // Which change feed the sync node has: `in-process` under the embedded database, where
        // this process's own writes reach subscribers; `replication` with a real one; `none`
        // when no sync role runs here. The label on the ready line is this same fact.
        liveFeed: server.running.liveFeed,
        buildId: server.buildId,
        manifest: join(root, MANIFEST_FILENAME),
        introspect: `${server.url}/_x`,
        panels: [...server.panels],
        mcp: server.mcp,
        mcpPaths: [...server.mcpPaths],
      },
      lines: [
        // A hard kill leaves the lock behind; clearing it is normal and worth one line, never a
        // finding. First, because it happened before anything else this run reports.
        ...(clearedStale ? [msg('cli.dev.staleLock')] : []),
        msg('cli.dev.roles', { roles: server.roles.join(', ') }),
        msg('cli.dev.panels', { panels: server.panels.join(', ') }),
        msg('cli.dev.manifest', { path: join(root, MANIFEST_FILENAME) }),
        msg('cli.dev.introspect', { url: `${server.url}/_x` }),
        // Only when something was mounted: the unmounted case has already said why, once, as a
        // warning with a fix, and a summary line reading `mcp none` would be a second copy of it.
        // One line per endpoint, so an app serving customers, staff and affiliates sees all three.
        ...server.mcpPaths.map((path) => msg('cli.dev.mcp', { path })),
      ],
    };
    await writeLock(services.stateDir, {
      pid: process.pid,
      port,
      url: server.url,
      startedAt: new Date().toISOString(),
    });
    if (ctx.args.flags.get('once') === true) {
      clearLock(services.stateDir);
      await server.stop();
      return result;
    }
    // Long-running: `dispatch` awaits this instead of exiting, so the watcher keeps reloading and
    // `/_x` stays reachable. Ctrl-C drains the web role through core's phases first and releases
    // the embedded Postgres, the worker and the watcher after — a hard kill leaves the PGlite
    // directory locked by a process that no longer exists.
    return {
      ...result,
      hold: holdUntilShutdown(
        'dev',
        async () => {
          // The lock first: a stop() that throws must not leave a file claiming this pid still owns
          // the directory, because the next boot would then refuse for a process that is gone.
          clearLock(services.stateDir);
          await server.stop();
        },
        // Released — the port, the lock and the embedded database are free for the next child.
        { exit: restart.exit },
      ),
    };
  },
};
