// Mounting the app's generated admin. `defineAdmin()` declares it; this file is the whole of what
// serves it — one catch-all under each admin's base path, in `x dev` and in the container alike,
// through the same document pipeline every page uses. The CLI contributes the HTTP crossing and
// nothing else: which screen a URL names, who may see it and what it renders are the admin's.

import type { AdminApp, AdminRouteConfig } from '@ultimat3/admin';
import type { Route, RouteMeta } from '@ultimat3/http';
import { asCtx, html, redirect, routeNotFound } from '@ultimat3/http';
import type { RouteEntry } from '@ultimat3/render';
import { compilePattern } from '@ultimat3/render';
import { renderSsr } from '@ultimat3/render/server';
import type { DocumentOptions } from './document-options';
import { routeDocument } from './runtime-render';

/**
 * `@ultimat3/admin`'s `ADMIN_MOUNTS`, read off the GLOBAL symbol registry rather than imported.
 * Importing that package loads every screen and registers its stylesheets, so an app that declared
 * no admin would carry one into its documents (axiom 6); asking the registry costs nothing. An app
 * that DID declare one has already loaded the package, which is when `screens()` below imports it.
 */
const ADMIN_MOUNTS: symbol = Symbol.for('ultimate.admin.mounts');

/** The file a mounted screen is attributed to — a package, because no app file declares it. */
export const ADMIN_MOUNT_FILE = '@ultimat3/admin';

const declared = (): ReadonlyMap<string, AdminApp> => {
  const held = (globalThis as { [key: symbol]: unknown })[ADMIN_MOUNTS];
  return held instanceof Map ? (held as ReadonlyMap<string, AdminApp>) : new Map();
};

export interface AdminMountOptions
  extends Pick<DocumentOptions, 'themeHead' | 'brandHead' | 'origin'> {
  readonly buildId: string;
}

/**
 * The route table's own entry shape, for a screen nobody registered there: the document builder
 * reads a `RouteEntry`, and an admin screen is a route — `ssr`, gated, `hydrate: 'never'` — whose
 * component is the body the screen just answered with.
 */
const entryFor = (route: AdminRouteConfig, body: unknown): RouteEntry => ({
  file: ADMIN_MOUNT_FILE,
  path: route.path,
  // An admin screen is behind sign-in: it carries the `app/` surface's stylesheet, never `site/`'s.
  surface: 'app',
  config: route.config,
  suspenseBoundaries: 0,
  islands: [],
  pattern: compilePattern(route.path),
  component: () => body,
});

/**
 * `auth: 'required'` is the pipeline's half — nobody anonymous reaches a screen, and a sign-in
 * redirect is the app's own. `enforcedBy: 'handler'` is the other half: the screen holds the row a
 * row-level rule reads, so deciding in the `authz` stage too would be a second authz system that
 * knows strictly less and answers first.
 */
const metaFor = (base: string): RouteMeta => ({
  name: `admin:${base}`,
  auth: 'required',
  policy: 'admin:read',
  enforcedBy: 'handler',
  render: 'ssr',
  tags: ['admin'],
});

async function answer(
  base: string,
  method: 'GET' | 'POST',
  options: AdminMountOptions,
  request: Parameters<Route['handler']>[0],
  context: Parameters<Route['handler']>[1],
): Promise<Response> {
  // Read per request, never captured: `x dev` re-evaluates the module that declares the admin
  // when it changes, and the admin a request meets is the one the author just saved.
  const app = declared().get(base);
  // Dynamic, and only here: reached only when an admin is mounted, by which point the app has
  // already loaded the package — and after `loadApp` installed the `.tsx` loader its screens need.
  const { adminRouteMatch } = await import('@ultimat3/admin');
  const matched = app === undefined ? null : adminRouteMatch(app, request.url.pathname);
  if (app === undefined || matched === null) throw routeNotFound(method, request.url.pathname);

  const form = method === 'POST' ? await request.bodyRaw() : null;
  const response = await matched.route.respond({
    ctx: await app.requestCtx(request.raw),
    params: matched.params,
    url: request.url.href,
    method,
    // A POST with no body is a form with no fields — a button-only form posts exactly that.
    form: method === 'POST' ? (isRecord(form) ? form : {}) : null,
  });
  if (response.kind === 'redirect') {
    // 303, always: the browser must GET the page it lands on, not re-POST the form at it.
    const moved = redirect(response.location, 303);
    moved.headers.set('cache-control', 'private, no-store');
    return moved;
  }

  const entry = entryFor(matched.route, response.body);
  const data = { url: request.url.href, params: matched.params };
  const result = await renderSsr(
    { entry, params: matched.params, url: request.url, ctx: asCtx(context) },
    () =>
      routeDocument(entry, data, {
        ...(options.themeHead === undefined ? {} : { themeHead: options.themeHead }),
        // The app's brand restyles its admin too: a screen is a document of the `app/` surface.
        ...(options.brandHead === undefined ? {} : { brandHead: options.brandHead }),
        ...(options.origin === undefined ? {} : { origin: options.origin }),
      }),
    { buildId: options.buildId, status: response.status },
  );
  // `renderSsr` answers the string the render function returned; a stream is `stream`'s shape.
  const document = typeof result.body === 'string' ? result.body : '';
  return html(document, { status: result.status, headers: result.headers });
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const METHODS: readonly ('GET' | 'POST')[] = ['GET', 'POST'];

/**
 * Two paths per admin and two methods on each: the base path itself (the dashboard) and one
 * catch-all under it. The admin's own table is matched INSIDE the handler, against the table as
 * it is now — so a page added in a save is served without this list being rebuilt, and a URL the
 * admin does not declare is the framework's ordinary 404.
 *
 * Empty for an app that declared no admin: nothing is mounted, and nothing is imported.
 */
export function adminMountRoutes(options: AdminMountOptions): readonly Route[] {
  return [...declared().keys()].flatMap((base) =>
    [base, `${base}/*rest`].flatMap((path) =>
      METHODS.map(
        (method): Route => ({
          method,
          path,
          meta: metaFor(base),
          handler: (request, context) => answer(base, method, options, request, context),
        }),
      ),
    ),
  );
}
