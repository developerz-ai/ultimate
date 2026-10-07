// `x routes` — the route table as a table, or as JSON. Replaces grepping a router directory, which
// is what an agent does when the framework has no answer to "what URLs exist".
//
// The rows are `route-table.ts`'s — the one builder the MCP dev tool `routes.list` reads too — so
// the CLI keeps no second table.

import type { Surface } from '@ultimat3/render';
import { SURFACES } from '@ultimat3/render';
import { loadApp } from './app-load';
import { requireAppRoot } from './app-root';
import { routesSpec } from './cmd-routes-spec';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError, UnknownCommandError } from './errors';
import { msg } from './messages';
import type { CommandResult } from './output';
import { flagString } from './parse';
import { plainAppRoutes, renderRouteRows, routeRows } from './route-table';

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
    const routes = routeRows(await plainAppRoutes(root)).filter(
      (route) => surface === undefined || route.surface === surface,
    );
    return {
      ok: findings.length === 0,
      command: 'routes',
      summary:
        routes.length === 0
          ? msg('cli.routes.empty')
          : msg('cli.routes.count', { count: routes.length }),
      lines: routes.length === 0 ? [] : renderRouteRows(routes).map((line) => `  ${line}`),
      findings,
      data: { routes: routes.map((route) => route.json) },
    };
  },
};
