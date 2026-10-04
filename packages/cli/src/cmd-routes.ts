// `x routes` — the route table as a table, or as JSON. Replaces grepping a router directory, which
// is what an agent does when the framework has no answer to "what URLs exist".
//
// The rows are `@ultimat3/render`'s own `describeRoutes()`: the CLI prints the route table, it
// does not keep a second one.

import type { RouteDescriptor, Surface } from '@ultimat3/render';
import { describeRoutes, SURFACES } from '@ultimat3/render';
import { loadApp } from './app-load';
import { requireAppRoot } from './app-root';
import { routesSpec } from './cmd-routes-spec';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError, UnknownCommandError } from './errors';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { flagString } from './parse';

/**
 * Where a route comes from. A file route names its file; a MOUNTED one names the call that
 * mounted it and every permission that gates it — there is no `page.tsx` to name, and printing the
 * package would send a reader looking for a route file inside `node_modules`.
 */
const declaredBy = (route: RouteDescriptor): string =>
  route.mount === undefined
    ? route.file
    : `${route.mount.by}() · ${route.mount.permissions.join(' + ')}`;

/** Fixed-width columns so the output diffs cleanly between runs and between machines. */
export function renderRouteTable(routes: readonly RouteDescriptor[]): readonly string[] {
  const rows = routes.map((route) => [
    route.path,
    route.surface,
    route.mode,
    route.hydrate,
    route.offline,
    declaredBy(route),
  ]);
  const header = ['path', 'surface', 'render', 'hydrate', 'offline', 'file'];
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((value, index) => value.padEnd(widths[index] ?? 0)).join('  ');
  return [line(header), ...rows.map(line)];
}

const routeJson = (routes: readonly RouteDescriptor[]): JsonValue =>
  routes.map((route) => ({
    path: route.path,
    surface: route.surface,
    file: route.file,
    render: route.mode,
    hydrate: route.hydrate,
    offline: route.offline,
    budget: { js: route.budgetJs },
    // Absent on a file route, never `null`: only a mounted route has the fact.
    ...(route.mount === undefined
      ? {}
      : { mount: { by: route.mount.by, permissions: [...route.mount.permissions] } }),
  }));

/**
 * A closed set, because the filter was a bare `===`: `x routes --surface App` and `--surface pages`
 * matched no row and reported `0 routes` with exit 0, which is the same output an app with no
 * routes gives — so a typo and an empty route table are indistinguishable, and only one of them is
 * a bug the caller can see. `SURFACES` is `@ultimat3/render`'s own declaration of what a surface
 * is; a list restated here would be a second answer to it (`x g --surface` is `generate-kinds.ts`'s
 * narrower question — which surface to SCAFFOLD onto — and takes site|app alone).
 */
export function readSurfaceFilter(raw: string | undefined): Surface | undefined {
  const surfaces: readonly string[] = SURFACES;
  if (raw === undefined) return undefined;
  if (surfaces.includes(raw)) return raw as Surface;
  throw new BadFlagError({
    flag: 'surface',
    command: 'routes',
    reason: `"${raw}" is not a surface (known: ${SURFACES.join(', ')})`,
    fix: 'x routes --surface app --json',
  });
}

export const routesCommand: CliCommand = {
  spec: routesSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('routes', ctx.cwd).dir;
    // No positional: `x routes list --json` ran only because a stray word was ignored, which is
    // how a retired spelling stayed in the route-miss fix lines. Refused before the app loads.
    const stray = ctx.args.positionals[0];
    if (stray !== undefined) {
      throw new UnknownCommandError({
        path: `routes ${stray}`,
        known: ['routes'],
        suggestion: 'routes --json',
      });
    }
    // Read before the app is loaded: a typo must not cost a boot to report, the rule `x mcp`'s
    // `--transport` already follows.
    const surface = readSurfaceFilter(flagString(ctx.args, 'surface'));
    const { findings } = await loadApp(root);
    const routes = describeRoutes().filter(
      (route) => surface === undefined || route.surface === surface,
    );
    return {
      ok: findings.length === 0,
      command: 'routes',
      summary:
        routes.length === 0
          ? msg('cli.routes.empty')
          : msg('cli.routes.count', { count: routes.length }),
      lines: routes.length === 0 ? [] : renderRouteTable(routes).map((line) => `  ${line}`),
      findings,
      data: { routes: routeJson(routes) },
    };
  },
};
