// `x routes` — the route table as a table, or as JSON. Replaces grepping a router directory, which
// is what an agent does when the framework has no answer to "what URLs exist".
//
// The rows are `@ultimat3/render`'s own `describeRoutes()`: the CLI prints the route table, it
// does not keep a second one.

import type { RouteDescriptor } from '@ultimat3/render';
import { describeRoutes } from '@ultimat3/render';
import { loadApp } from './app-load';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { flagString } from './parse';

/** Fixed-width columns so the output diffs cleanly between runs and between machines. */
export function renderRouteTable(routes: readonly RouteDescriptor[]): readonly string[] {
  const rows = routes.map((route) => [
    route.path,
    route.surface,
    route.mode,
    route.hydrate,
    route.offline,
    route.file,
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
    budget: { js: route.budgetJs, lcp: route.budgetLcp },
  }));

export const routesCommand: CliCommand = {
  spec: {
    name: 'routes',
    summary: 'the route table: path, surface, render mode, hydrate, offline',
    usage: 'x routes [--surface site|app] [--json]',
    requiresApp: true,
    flags: [{ name: 'surface', type: 'string', summary: 'filter by surface' }],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('routes', ctx.cwd).dir;
    const { findings } = await loadApp(root);
    const surface = flagString(ctx.args, 'surface');
    const routes = describeRoutes().filter(
      (route) => surface === undefined || route.surface === surface,
    );
    return {
      ok: findings.length === 0,
      command: 'routes',
      summary: routes.length === 0 ? msg('cli.routes.empty') : `${routes.length} routes`,
      lines: routes.length === 0 ? [] : renderRouteTable(routes).map((line) => `  ${line}`),
      findings,
      data: { routes: routeJson(routes) },
    };
  },
};
