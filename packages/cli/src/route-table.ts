// The served route table, as rows: the pages (`describePages()`), then every API route — the
// action and query projections `apiRoutes()` builds for `x dev` and the container, and the plain
// routes of `apps/<app>/runtime.ts`. `x routes` and the MCP dev tool `routes.list` both read it.

import type { Route } from '@ultimat3/http';
import type { RouteDescriptor, Surface } from '@ultimat3/render';
import { describePages } from '@ultimat3/render';
import { apiRoutes } from './api-routes';
import { loadAppRuntime } from './app-runtime';
import type { JsonValue } from './output';

/** One printed and one JSON row per served route: a page, a mounted page, or an API route. */
export interface RouteRow {
  readonly surface: Surface;
  readonly path: string;
  readonly cells: readonly string[];
  readonly json: JsonValue;
}

/**
 * Where a route comes from. A file route names its file; a MOUNTED one names the call that
 * mounted it and every permission that gates it — there is no `page.tsx` to name, and printing the
 * package would send a reader looking for a route file inside `node_modules`.
 */
const declaredBy = (route: RouteDescriptor): string =>
  route.mount === undefined
    ? route.file
    : `${route.mount.by}() · ${route.mount.permissions.join(' + ')}`;

const pageRow = (route: RouteDescriptor): RouteRow => ({
  surface: route.surface,
  path: route.path,
  cells: [
    'GET',
    route.path,
    route.surface,
    route.mode,
    route.hydrate,
    route.offline,
    declaredBy(route),
  ],
  json: {
    method: 'GET',
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
  },
});

/**
 * An action or query projection, or a plain `runtime.ts` route (`primitive: null`). It renders
 * nothing, so the page columns read `-`; where a page names its file this names what declared it
 * and the permission its policy asks for.
 */
const apiRow = (route: Route): RouteRow => {
  const primitive = route.meta.primitive ?? null;
  const policy = route.meta.policy ?? null;
  const from = primitive === null ? 'runtime.ts routes' : primitive;
  const by = `${from} ${route.meta.name}${policy === null ? '' : ` · ${policy}`}`;
  return {
    surface: 'api',
    path: route.path,
    cells: [route.method, route.path, 'api', '-', '-', '-', by],
    json: {
      method: route.method,
      path: route.path,
      surface: 'api',
      primitive,
      name: route.meta.name,
      auth: route.meta.auth,
      policy,
    },
  };
};

const byPath = (a: RouteRow, b: RouteRow): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/** Pages first, in the page table's order; then the API, by path, so the listing diffs cleanly. */
export function routeRows(plain: readonly Route[] = []): readonly RouteRow[] {
  return [...describePages().map(pageRow), ...[...apiRoutes(), ...plain].map(apiRow).sort(byPath)];
}

/**
 * The plain HTTP routes `apps/<app>/runtime.ts` declares — the ones `X_BODY_INVALID` is about,
 * since an action or query validates its own input. Loaded as `x dev` loads them.
 */
export async function plainAppRoutes(root: string): Promise<readonly Route[]> {
  return (await loadAppRuntime(root))?.routes ?? [];
}

/** Fixed-width columns so the output diffs cleanly between runs and between machines. */
export function renderRouteTable(routes: readonly RouteDescriptor[]): readonly string[] {
  return renderRouteRows(routes.map(pageRow));
}

export function renderRouteRows(rows: readonly RouteRow[]): readonly string[] {
  const header = ['method', 'path', 'surface', 'render', 'hydrate', 'offline', 'declared by'];
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => (row.cells[index] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((value, index) => value.padEnd(widths[index] ?? 0)).join('  ');
  return [line(header), ...rows.map((row) => line(row.cells))];
}
