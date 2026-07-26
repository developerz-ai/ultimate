// `x routes` — the route table as a table, or as JSON. Replaces grepping a router directory, which
// is what an agent does when the framework has no answer to "what URLs exist".

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import type { AppManifest, ManifestEntry } from './manifest-scan';
import { routesOf, scanApp } from './manifest-scan';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { flagString } from './parse';

const cell = (value: unknown): string => (value === undefined ? '-' : String(value));

/** Fixed-width columns so the output diffs cleanly between runs and between machines. */
export function renderRouteTable(routes: readonly ManifestEntry[]): readonly string[] {
  const rows = routes.map((route) => [
    route.path ?? route.name,
    route.surface,
    cell(route.meta['render']),
    cell(route.meta['hydrate']),
    cell(route.meta['offline']),
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

const routeJson = (manifest: AppManifest): JsonValue => ({
  buildId: manifest.buildId,
  routes: routesOf(manifest).map((route) => ({
    path: route.path ?? route.name,
    surface: route.surface,
    file: route.file,
    render: cell(route.meta['render']),
    hydrate: cell(route.meta['hydrate']),
    offline: cell(route.meta['offline']),
  })),
});

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
    const committed = join(root, 'x.manifest.json');
    const manifest = existsSync(committed)
      ? ((await Bun.file(committed).json()) as AppManifest)
      : await scanApp({ root });
    const surface = flagString(ctx.args, 'surface');
    const routes = routesOf(manifest).filter(
      (route) => surface === undefined || route.surface === surface,
    );
    return {
      ok: true,
      command: 'routes',
      summary: routes.length === 0 ? msg('cli.routes.empty') : `${routes.length} routes`,
      lines: routes.length === 0 ? [] : renderRouteTable(routes).map((line) => `  ${line}`),
      data: routeJson({ ...manifest, entries: routes }),
    };
  },
};
