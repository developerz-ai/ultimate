// What the server renders, for a unit test: `renderView` for one component, `renderRoute` for a
// whole route module — its `load`, its `meta` and its page, resolved the way a request resolves
// them. No browser, no server, no cast: a test asserts on markup and on visible text.

import type { Actor } from '@ultimat3/core';
import { assert, ctxOf, runWithContext } from '@ultimat3/core';
import type { AssetPath, IslandDirective, RouteConfig, RouteParams } from '@ultimat3/render';

/** What a component rendered. */
export interface RenderedView {
  /** The markup, exactly as the document would carry it. */
  readonly html: string;
  /**
   * What a reader sees: tags, scripts and styles removed, entities decoded, whitespace collapsed
   * to single spaces. Compare it with `t('<key>')` — the markup escapes what the catalog does not.
   */
  readonly text: string;
}

/** What a route rendered for one request. */
export interface RenderedRoute<TData> extends RenderedView {
  /** What `load` resolved — the one object `meta` and the page were both given. */
  readonly data: TData;
  readonly meta: Awaited<ReturnType<RouteConfig<TData>['meta']>>;
  /** The islands this render emitted, in order. Empty on a page that ships no JavaScript. */
  readonly islands: readonly IslandDirective[];
  /**
   * The app-wide favicon's URL, when one was declared and the app's site asset table answered:
   * the content-hashed URL `/assets/*` serves — the same one the document's
   * `<link rel="icon" type="image/svg+xml">` carries.
   *
   * `undefined` when the app declares no favicon, and `undefined` when the URL cannot be
   * resolved: a unit test that never loaded the app has no site asset table installed, and a
   * route still renders.
   */
  readonly favicon?: string | undefined;
}

/**
 * A route file's exports, passed whole: `import * as page from './page'`. Only `config` is typed —
 * the page component is found among the rest by the rule the router finds it by.
 */
export interface RouteModule<TData> {
  readonly config: RouteConfig<TData>;
  /** Everything else the file exports — the page among it. Open, so a literal module typechecks. */
  readonly [exported: string]: unknown;
}

export interface RouteRequest {
  /** Absolute, as a request's is. Its search string becomes the page's `query`. */
  readonly url?: string;
  readonly params?: RouteParams;
  /** Who is asking. `load` and the page run inside a request context holding this actor. */
  readonly actor?: Actor;
  /**
   * The app's favicon — the app-wide declaration in `app.config.ts` (`site.favicon`), the one
   * SVG every document of the app links. It is the APP's fact, not the route's: the route
   * repeats nothing, and the render resolves it through the app's own site asset table so a
   * test can see the URL `/assets/*` will serve.
   *
   * Optional: an app that declares no favicon, and a test that never loaded the app, both ask
   * for a route with no favicon to resolve.
   */
  readonly favicon?: AssetPath | undefined;
}

const DEFAULT_URL = 'http://localhost/';

const SCRIPT_OR_STYLE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/g;

/**
 * `&amp;` last: decoding it first would turn the text `&amp;lt;` — an author's literal `&lt;` —
 * into `<`, a character the page never showed.
 */
const visibleText = (html: string): string =>
  html
    .replace(SCRIPT_OR_STYLE, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
    .trim();

const viewOf = (html: string): RenderedView => ({ html, text: visibleText(html) });

/**
 * The favicon's URL through the app's own site asset table — `asset()`'s answer, the same URL
 * the document's `<link rel="icon">` carries and `/assets/*` serves.
 *
 * `undefined` when the app declares no favicon, and `undefined` when the URL cannot be
 * resolved: a unit test that never loaded the app has no site asset table installed, and
 * `asset()` refuses by name there. A route render is not a document, so a favicon it cannot
 * resolve is no reason to fail the render — the app's BOOT is where a declared favicon that is
 * not on disk is refused (`X_ASSET_MISSING`), and a test asks about a route, not about the
 * app's icon.
 */
const faviconUrl = async (
  render: typeof import('@ultimat3/render'),
  favicon: AssetPath | undefined,
): Promise<string | undefined> => {
  if (favicon === undefined) return undefined;
  try {
    return render.asset(favicon);
  } catch {
    return undefined;
  }
};

/**
 * Render one component with the props a page would hand it. The props are the component's own
 * type, so a renamed prop is a compile error in the test rather than an `undefined` in the markup.
 *
 * No island collector: a component that renders an `island()` belongs to a route, which is where
 * its hydration timing comes from — render it through `renderRoute`.
 */
export async function renderView<Props>(
  component: (props: Props) => unknown,
  props: Props,
): Promise<RenderedView> {
  const { renderToHtml } = await import('@ultimat3/render/server');
  return viewOf(await renderToHtml(component(props)));
}

/**
 * Render a route module the way a request does: `load` once, `meta` and the page on that same
 * data, islands collected under the route's own `hydrate`. Pass the module whole —
 * `import * as page from './page'` — so the page is found by the rule the router finds it by.
 */
export async function renderRoute<TData>(
  module: RouteModule<TData>,
  request: RouteRequest = {},
): Promise<RenderedRoute<TData>> {
  const render = await import('@ultimat3/render');
  const { renderToHtml } = await import('@ultimat3/render/server');
  const { config } = module;
  // A copy typed by its own shape: the page is one of the exports `RouteModule` does not name.
  const exported: Readonly<Record<string, unknown>> = { ...module };
  const component = render.pageComponentOf(exported);
  assert(
    component !== undefined,
    'renderRoute was handed a route module that exports no page component',
    "export the page beside `config` — `export function Page()` — and pass the module whole: import * as page from './page'",
  );
  const url = request.url ?? DEFAULT_URL;
  const ctx = { params: request.params ?? {}, url };
  const islands = render.islandCollector({ file: url, hydrate: config.hydrate });
  // The app's favicon, resolved through the app's own asset table — and skipped when there is
  // no table to ask, so a route renders with no favicon setup at all.
  const favicon = await faviconUrl(render, request.favicon);

  const run = async (): Promise<RenderedRoute<TData>> => {
    const data = await render.routeDataFor(config, ctx);
    const meta = await config.meta(render.metaContextFor(ctx, data));
    const query = Object.fromEntries(new URL(url).searchParams);
    const html = await renderToHtml(component({ data, params: ctx.params, url, query }), {
      islands,
    });
    return { ...viewOf(html), data, meta, islands: islands.directives, favicon };
  };

  if (request.actor === undefined) return run();
  return runWithContext(ctxOf({ actor: request.actor }), run);
}
