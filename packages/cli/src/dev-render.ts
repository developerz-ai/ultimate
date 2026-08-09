// Projecting the route table onto HTTP routes `x dev` can serve. Every mode goes through
// `@ultimat3/render`'s own function for that mode — the CLI picks the mode and supplies the
// document, it never decides what a mode means or what headers it earns.
//
// The document is head + shell. Islands are the compiled client graph's, and there is no
// compiled graph before `x build`, so a dev page serves its real `<head>`, its real status and
// its real cache headers around an empty root — never a 404.

import type { Ctx } from '@ultimat3/core';
import type { RouteMeta as HttpRouteMeta, Route, RouteParams } from '@ultimat3/http';
import { asCtx, html, stream } from '@ultimat3/http';
import type { IsrController, RenderResult, RouteEntry } from '@ultimat3/render';
import {
  contentHash,
  createIsrController,
  headFromMeta,
  renderHead,
  renderSpa,
  renderSsr,
  routeEntries,
  SPA_ROOT_ID,
  seoRenderers,
  staticHeaders,
  streamResult,
} from '@ultimat3/render';

export interface DevRenderOptions {
  readonly buildId: string;
  /** Injected so a test can drive the ISR store without a timer. */
  readonly isr?: IsrController;
}

/** What a route's `meta(data)` is given. `url` is a string because that is what `ld.*` embeds. */
export interface DevRouteData extends Record<string, unknown> {
  readonly url: string;
  readonly params: RouteParams;
}

const LANG = 'en';

const headFor = async (entry: RouteEntry, data: DevRouteData): Promise<string> =>
  renderHead(
    headFromMeta(await entry.config.meta(data), seoRenderers({ path: new URL(data.url).pathname })),
  );

async function documentFor(entry: RouteEntry, data: DevRouteData): Promise<string> {
  return shellFor(await headFor(entry, data));
}

const shellFor = (head: string): string =>
  `<!doctype html><html lang="${LANG}"><head>${head}</head>` +
  `<body><div id="${SPA_ROOT_ID}"></div></body></html>`;

async function resultFor(
  entry: RouteEntry,
  data: DevRouteData,
  options: DevRenderOptions,
  isr: IsrController,
  ctx: Ctx,
): Promise<RenderResult> {
  const url = new URL(data.url);
  switch (entry.config.render) {
    case 'static': {
      // Not `renderStatic`: that enumerates every prerendered path for the build. A request
      // names exactly one, and it earns the same content-hashed headers.
      const body = await documentFor(entry, data);
      return { status: 200, headers: staticHeaders(contentHash(body), options.buildId), body };
    }
    case 'isr': {
      const served = await isr.serve(url.pathname, () => documentFor(entry, data));
      return served.result;
    }
    case 'spa':
      return renderSpa({
        entry,
        buildId: options.buildId,
        head: await headFor(entry, data),
        chunks: [],
        lang: LANG,
      });
    case 'stream': {
      const head = await headFor(entry, data);
      return streamResult(
        {
          head: `<!doctype html><html lang="${LANG}"><head>${head}</head><body>`,
          shell: `<div id="${SPA_ROOT_ID}"></div>`,
          holes: [],
        },
        { buildId: options.buildId },
      );
    }
    default:
      return renderSsr({ entry, params: data.params, url, ctx }, () => documentFor(entry, data), {
        buildId: options.buildId,
      });
  }
}

const responseOf = (result: RenderResult): Response =>
  typeof result.body === 'string'
    ? html(result.body, { status: result.status, headers: result.headers })
    : stream(result.body, { status: result.status, headers: result.headers });

/**
 * `auth` follows the route's own guard, so a gated page is gated in dev by the same pipeline
 * stage that gates it in production. A route that declares no policy is public by declaration.
 */
const metaOf = (entry: RouteEntry): HttpRouteMeta => ({
  name: entry.file,
  auth: entry.config.policy === undefined ? 'public' : 'required',
  render: entry.config.render,
  tags: [entry.surface],
  ...(entry.config.policy === undefined ? {} : { policy: entry.config.policy.permission }),
});

/** One HTTP route per registered `route` primitive, in the table's own order. */
export function appRoutes(options: DevRenderOptions): readonly Route[] {
  const isr = options.isr ?? createIsrController({ buildId: options.buildId });
  return routeEntries().map((entry) => ({
    method: 'GET' as const,
    path: entry.path,
    meta: metaOf(entry),
    // `ctx.params` is the router's own match — the CLI never re-parses a path it did not match.
    handler: async (request, ctx): Promise<Response> => {
      const data: DevRouteData = { url: request.url.href, params: ctx.params };
      return responseOf(await resultFor(entry, data, options, isr, asCtx(ctx)));
    },
  }));
}
