// The app's own error page, which only a process with a disk can find: `@ultimat3/http` renders the
// framework's and declares the seam, this file is the half that reads a file. Rails' `public/404.html`,
// one directory further in — `apps/web/site/` is already where an app's public files live, which is
// where `favicon.ico` is overridden too.

// why: Bun exposes no path-join primitive, and the source path is app-root-relative — the same
// necessity `favicon.ts` records for `FAVICON_SOURCE`.
import { join } from 'node:path';
import { renderErrorPage } from '@ultimat3/http';
import { currentLocale } from '@ultimat3/i18n';

/**
 * One file per status, named by the status, and NO generic `error.html` beside it: a second rung
 * would need a precedence rule, and a `{{status}}` slot would be a template language the framework
 * does not otherwise have. An app that wants one page for three statuses writes three files.
 */
export const ERROR_PAGE_DIR = 'apps/web/site/errors';

/** What `x verify`, a `fix:` and this reader all name — never spelled twice. */
export const errorPageSource = (status: number): string =>
  `${ERROR_PAGE_DIR}/${String(status)}.html`;

/**
 * What a static host serves for a path that matches no file. `404.html` at the export root is the
 * convention S3, Cloudflare Pages, Netlify and nginx already look for, so the artifact needs no
 * configuration to answer the way the served process does.
 */
export const STATIC_ERROR_PAGE = '404.html';

/** A status a `Response` can carry. A number outside it never becomes a path. */
const isStatus = (status: number): boolean =>
  Number.isInteger(status) && status >= 100 && status <= 599;

/**
 * The app's page for one status, or `undefined`.
 *
 * Read per REQUEST, never cached at boot, for `favicon.ts`'s reason: `x dev` is a running process
 * an author drops a file into, and a reader that captured "there was none" at startup would keep
 * answering the framework's page until the server was restarted.
 */
export async function errorPageOverride(root: string, status: number): Promise<string | undefined> {
  if (!isStatus(status)) return undefined;
  const file = Bun.file(join(root, errorPageSource(status)));
  return (await file.exists()) ? file.text() : undefined;
}

/**
 * `ServerHooks.errorPage`, bound to one app root. Installed by `startWeb` so `x dev` and the
 * container cannot answer a browser differently — the rule `assetRoutes` already holds for
 * `/favicon.ico`.
 */
export const errorPageHook =
  (root: string) =>
  (status: number): Promise<string | undefined> =>
    errorPageOverride(root, status);

/**
 * The document that goes into a static export: the app's file if it has one, the framework's page
 * otherwise. Its own function because the export has no process to ask, exactly as `faviconBytes`
 * is — a second rule for which page a static build carries would be an artifact that disagrees
 * with the server it was built from.
 *
 * No request id and no pathname: nothing about this file is per-request, and the renderer omits
 * both rather than inventing them.
 */
export async function errorPageDocument(root: string, status: number): Promise<string> {
  const own = await errorPageOverride(root, status);
  return (
    own ??
    renderErrorPage({
      status,
      // What the served 404 carries, so the artifact and the process name one code.
      code: 'X_ROUTE_NOT_FOUND',
      // The app's default, resolved after `loadApp` registered its catalogs — a build has no
      // request to negotiate against.
      locale: currentLocale(),
    })
  );
}
