// Single responsibility: the server half of client error reporting — `GET /x-client-errors.js`
// and `POST /_client-errors`, which turns one browser report into one `reportError` call with
// `source: 'browser'`. A framework route like `/_storage`, never an action: it must not appear in
// OpenAPI or as an MCP tool. Mounted by `x dev` and the container alike, only when enabled.

import type { ClientErrorsConfig } from '@ultimat3/core';
import {
  escapeHtml,
  isJsonObject,
  proveSameOrigin,
  readWithinLimit,
  renderFixShellArg,
  reportError,
  UltimateError,
} from '@ultimat3/core';
import type { RequestContext, Route, UltimateRequest } from '@ultimat3/http';
import { HttpError, NO_STORE, selfOrigin } from '@ultimat3/http';
import type { RouteEntry } from '@ultimat3/render';
import { routeEntries } from '@ultimat3/render';
import { t } from '@ultimat3/schema';
import {
  CLIENT_ERRORS_LIMITS,
  CLIENT_ERRORS_PATH,
  CLIENT_ERRORS_SCRIPT_PATH,
  clientErrorsScript,
} from './client-errors-script';
import { revalidatedResponse } from './revalidated-response';

/** A report is five short strings; 32 KiB is every cap below with room, and nothing more. */
export const CLIENT_ERRORS_MAX_BODY_BYTES = 32 * 1024;

const KINDS = ['error', 'rejection', 'island'] as const;

/**
 * A path, never a URL and never a query: a query string is where a token or an email rides. No C0
 * control or DEL either: the path lands in `scope.extra`, and a monitor or a terminal renders it.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the class REFUSES them, by design.
const PATH = /^\/[^?#\s\x00-\x1f\x7f]*$/;

/** An island's id is `islandModuleId`'s `[a-z0-9-]`; anything else did not come from a page. */
const ISLAND = /^[a-z0-9-]+$/;

const REPORT = t.object({
  kind: t.enumerated(...KINDS),
  message: t.string.max(CLIENT_ERRORS_LIMITS.message),
  path: t.string.max(CLIENT_ERRORS_LIMITS.path).pattern(PATH),
  build: t.string.max(CLIENT_ERRORS_LIMITS.build),
  stack: t.string.max(CLIENT_ERRORS_LIMITS.stack).optional(),
  island: t.string.min(1).max(CLIENT_ERRORS_LIMITS.island).pattern(ISLAND).optional(),
});

/** CLOSED: the schema drops an unknown key, and a report shape that grows quietly is not closed. */
const KEYS: ReadonlySet<string> = new Set(Object.keys(REPORT.shape));

/** The page facts the operation is resolved from — `routeEntries()`, or a test's list. */
export type ClientErrorPage = Pick<RouteEntry, 'path' | 'surface' | 'pattern' | 'islands'>;

export interface ClientErrorsRouteOptions {
  readonly pages?: () => readonly ClientErrorPage[];
}

const refused = (pathname: string, why: string): HttpError =>
  new HttpError({
    code: 'X_BODY_INVALID',
    cause: `${pathname} refused a client error report: ${why}`,
    fix: "reportError(error, { source: 'http' }) from @ultimat3/core for a server-side failure — this route takes only the shape /x-client-errors.js sends from an app/ page",
  });

/**
 * Same-origin PROVEN, stricter than the pipeline's `csrf` stage: that one lets an anonymous request
 * with no browser evidence through as a webhook, and this route has no webhook caller. A cross-site
 * page must not file through a signed-in browser, and a script with no headers is not a browser.
 */
function assertSameOrigin(request: UltimateRequest, ctx: RequestContext): void {
  const verdict = proveSameOrigin({
    selfOrigins: [selfOrigin(ctx.url, ctx.https)],
    origin: request.header('origin'),
    secFetchSite: request.header('sec-fetch-site') || null,
    listed: () => false,
    listName: "the app's own origin",
  });
  if (verdict.ok) return;
  throw new HttpError({
    code: 'X_CSRF_BLOCKED',
    cause: `${ctx.url.pathname} refused a client error report it could not show came from this app: ${verdict.reason}`,
    fix: "fetch('/_client-errors', { method: 'POST', credentials: 'same-origin' }) from a page served on this same origin — /x-client-errors.js on an app/ document does exactly that; a request with neither sec-fetch-site nor Origin is refused",
  });
}

/** The parsed report, or the refusal naming what was wrong — never the body echoed back. */
async function reportOf(request: UltimateRequest, pathname: string) {
  const read = await readWithinLimit(request.raw.body, CLIENT_ERRORS_MAX_BODY_BYTES);
  if ('over' in read) {
    throw refused(pathname, `the body is over ${CLIENT_ERRORS_MAX_BODY_BYTES} bytes`);
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(read.bytes));
  } catch {
    throw refused(pathname, 'the body is not JSON');
  }
  if (!isJsonObject(body)) throw refused(pathname, 'the body is not a JSON object');
  const unknown = Object.keys(body).filter((key) => !KEYS.has(key));
  if (unknown.length > 0) {
    throw refused(pathname, `${unknown.length} key(s) outside ${[...KEYS].join(', ')}`);
  }
  const parsed = REPORT.safeParse(body);
  if (parsed.issues !== undefined) {
    const where = parsed.issues.map((issue) => issue.path?.map(String).join('.') ?? '').join(', ');
    throw refused(pathname, `field(s) out of shape: ${where}`);
  }
  return parsed.value;
}

/**
 * The grouping facet: the page PATTERN, plus the island id only when this build serves it. The id
 * is the browser's to choose, and an invented one per report would be a new fingerprint group per
 * report — so a report naming an island no page declares is filed (`meta.island`) with NO
 * operation, one group for every such report.
 */
function operationOf(
  pages: readonly ClientErrorPage[],
  path: string,
  island: string | undefined,
): string | undefined {
  const pattern = patternOf(pages, path);
  if (pattern === undefined || island === undefined) return pattern;
  return pages.some((page) => page.islands.includes(island)) ? `${pattern} ${island}` : undefined;
}

/** The most specific `app/` page the path names — the PATTERN, the one bounded grouping facet. */
function patternOf(pages: readonly ClientErrorPage[], path: string): string | undefined {
  let best: ClientErrorPage | undefined;
  for (const page of pages) {
    if (page.surface !== 'app' || !page.pattern.regex.test(path)) continue;
    if (best === undefined || page.pattern.specificity > best.pattern.specificity) best = page;
  }
  return best?.path;
}

export function clientErrorsRoutes(
  config: ClientErrorsConfig,
  options: ClientErrorsRouteOptions = {},
): readonly Route[] {
  const pages = options.pages ?? routeEntries;
  const source = clientErrorsScript();
  return [
    {
      method: 'GET',
      path: CLIENT_ERRORS_SCRIPT_PATH,
      meta: { name: 'clientErrors.script', auth: 'public' },
      // No content hash in the URL — every `app/` document names it — so revalidated, as
      // `/x-sw-register.js` is: a changed script reaches a returning tab on its next load.
      handler: (request) => revalidatedResponse(request, source, 'text/javascript; charset=utf-8'),
    },
    {
      method: 'POST',
      path: CLIENT_ERRORS_PATH,
      meta: {
        name: 'clientErrors.report',
        // `required` unless the app opened the door: the pipeline answers an anonymous caller 401.
        auth: config.anonymous ? 'public' : 'required',
        cache: NO_STORE,
        // The pipeline's `rate-limit` stage spends it, per actor or (anonymous) per address, on the
        // app's own store — fleet-wide when the app declared `scope: 'shared'`, never a second one.
        rateLimit: 'clientErrors.report',
        rateLimitBucket: { capacity: config.perMinute, refillPerSecond: config.perMinute / 60 },
      },
      handler: async (request, ctx) => {
        assertSameOrigin(request, ctx);
        const report = await reportOf(request, ctx.url.pathname);
        const operation = operationOf(pages(), report.path, report.island);
        const error = new UltimateError({
          code: 'X_CLIENT_ERROR',
          cause: report.message === '' ? `a ${report.kind} with no message` : report.message,
          fix: `x shot ${renderFixShellArg(report.path, '<route>')} --json`,
          meta: {
            clientBuild: report.build,
            kind: report.kind,
            ...(report.island === undefined ? {} : { island: report.island }),
          },
        });
        // The BROWSER's stack is the report's; the one this line just captured is the server's.
        Object.defineProperty(error, 'stack', { value: report.stack, configurable: true });
        reportError(error, {
          source: 'browser',
          scope: {
            // Pattern plus island: `errorFingerprint` groups on it, so one island's fault is one
            // group on every `/posts/:id`, and two islands on one page are two.
            ...(operation === undefined ? {} : { operation }),
            extra: { path: report.path },
          },
        });
        return new Response(null, { status: 204 });
      },
    },
  ];
}

/** The tag an `app/` document carries: the build it was rendered BY, so a stale tab says so. */
export const clientErrorsHead = (buildId: string): string =>
  `<script src="${CLIENT_ERRORS_SCRIPT_PATH}" data-build="${escapeHtml(buildId)}" defer></script>`;

export interface ClientErrorsSurface {
  readonly routes: readonly Route[];
  /** For `DocumentOptions.appHead`: `app/` documents only — `site/` never pays for it. */
  readonly head: string;
}

/** What a boot mounts for `app.config.ts`'s `clientErrors`: nothing at all unless enabled. */
export function clientErrorsSurface(
  config: ClientErrorsConfig | undefined,
  buildId: string,
): ClientErrorsSurface | undefined {
  if (config?.enabled !== true) return undefined;
  return { routes: clientErrorsRoutes(config), head: clientErrorsHead(buildId) };
}

/**
 * A static export runs no route table, so there is nothing to receive a report: no document names
 * the script, and the build SAYS so — `originWarning`'s shape, into the report's `warnings`.
 */
export function clientErrorsStaticWarning(config: ClientErrorsConfig | undefined): string[] {
  if (config?.enabled !== true) return [];
  return [
    'clientErrors.enabled is true and a static export serves no /_client-errors route, so no exported document names /x-client-errors.js — serve the app (x dev, or the container) for browser reports',
  ];
}
