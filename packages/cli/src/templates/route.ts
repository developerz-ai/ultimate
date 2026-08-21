// `x g route <path>` — a URL, its render mode, its metadata, its offline strategy and its budget.
// Two generated tests, because the gate types a test by its filename: `page.test.ts` pins metadata
// presence and the budget declaration on the `unit` step, `page.e2e.test.ts` pins the offline
// fallback on the `e2e` step. A route with no title is an SEO regression and a route with no
// fallback is a blank screen on a train.

import { catalogJson } from './catalog-json';
import { catalogPath, resolveLocales } from './locales';
import type { GeneratedFile } from './naming';
import { kebab, pascal, titleKey } from './naming';

export type Surface = 'site' | 'app';

/**
 * `ssr` on `app/`, not `stream`, for the reason `scaffold-app.ts`'s dashboard already states:
 * `stream` sets `needsSuspense`, the framework ships no hole marker, and `defineRoute` therefore
 * throws `X_ROUTE_MODE_INVALID` at import. That is not a failing page — it is a page that registers
 * NO route at all, so every `x g route --surface app` and every `x g resource` scaffolded a URL
 * that was absent from `x routes`, from the manifest and from `budgets`. Ship the mode that works.
 */
const RENDER: Record<Surface, string> = { site: 'isr', app: 'ssr' };
/**
 * `app` is `'visible'` on a page the generator writes with no island, and that is not an oversight.
 * A declared strategy costs nothing when there is nothing to hydrate — `hydrateRuntime` is emitted
 * per island DIRECTIVE and answers `''` for a page with none (`packages/render/src/hydrate.ts`), so
 * `x routes` reads `visible` while the document ships 0 bytes. What it buys is that adding the
 * first island is one edit: a declared `'never'` beside an island is `X_ISLAND_NOT_HYDRATED`, which
 * `defineRoute` refuses on purpose, so the scaffold would break at the moment it is first used.
 */
const HYDRATE: Record<Surface, string> = { site: 'never', app: 'visible' };
const OFFLINE: Record<Surface, string> = { site: 'precache', app: 'runtime' };
/**
 * Structured, not a literal string: the route and the test that pins it read the same fact.
 *
 * `lcp` is deliberately NOT here. `RouteBudget.lcp` is accepted by `defineRoute`, and nothing in
 * the framework can produce the `lcpMs` that `checkBudgets` compares it against — `prerender.ts`
 * emits static HTML and there is no browser in the build to observe a paint. A scaffolded `lcp`
 * was therefore a budget that reads as declared, is never weighed, and passes silently the moment
 * a `build-stats.json` row exists: the false green `budgets.ts`'s own header forbids. Scaffolding
 * only what the build measures is the half of "delete it or thread it" that `x new` can act on.
 */
const BUDGET: Record<Surface, { readonly js: string }> = {
  site: { js: '0kb' },
  app: { js: '60kb' },
};
const budgetLiteral = (surface: Surface): string => `{ js: '${BUDGET[surface].js}' }`;
/** `isr` without a trigger is `static` wearing a costume — @ultimat3/render rejects it at boot. */
const REVALIDATE: Record<Surface, string> = { site: "\n  revalidate: { ttl: '1h' },", app: '' };

/** `[slug]`, `[...rest]` — the repo's own convention (`app/posts/[id]`, `site/blog/[slug]`). */
const DYNAMIC_SEGMENT = /^\[(?<spread>\.\.\.)?(?<name>[^\]]+)\]$/;

/**
 * One URL segment. `kebab()` strips `[` and `]` along with every other non-alphanumeric, so
 * `x g route "posts/[slug]"` scaffolded `apps/web/app/posts/slug/page.tsx` — a different, STATIC
 * route — and reported `ok:true` with no warning. Only the parameter NAME is kebabed now.
 */
export const routeSegment = (part: string): string => {
  const match = DYNAMIC_SEGMENT.exec(part);
  if (match === null) return kebab(part);
  return `[${match.groups?.['spread'] ?? ''}${kebab(match.groups?.['name'] ?? '')}]`;
};

const segmentsOf = (path: string): readonly string[] =>
  path
    .split('/')
    .filter((part) => part.length > 0)
    .map(routeSegment);

/** Every `[param]` the URL declares, in order — what a render actually hands the page. */
export const routeParams = (path: string): readonly string[] =>
  segmentsOf(path).flatMap((part) => {
    const name = DYNAMIC_SEGMENT.exec(part)?.groups?.['name'];
    return name === undefined ? [] : [name];
  });

/**
 * Where the page lands. Exported because an island's `src` is resolved relative to the PAGE, and
 * only this function knows where `x g resource`'s page went — a second copy of the formula in the
 * resource generator is how the specifier it prints stops matching the file it writes.
 */
export const routeDir = (surface: Surface, path: string): string =>
  `apps/web/${surface}/${segmentsOf(path).join('/')}`;

/**
 * How the generated page reaches a string, and it is the whole reason this generator takes an app
 * module at all. `useT()` comes from the app's own catalog module — the one that calls
 * `defineCatalogs()` — so a page that renders a string DEPENDS on the module that registers them.
 * Reaching straight for `t` in `@ultimat3/i18n` renders strings while depending on nothing, which
 * is how a shipped app served `⟦app.play.title⟧` on every page with a green gate (issue #249), and
 * this generator is where that idiom came from.
 *
 * An app with no catalog module keeps the framework import: emitting one that cannot resolve would
 * trade a wrong idiom for a file that does not compile.
 */
const catalogImport = (module: string | undefined): string =>
  module === undefined
    ? "import { t } from '@ultimat3/i18n';"
    : `import { useT } from '${module}';`;

/** `useT()` is per render, so the body binds it; `meta` takes the router's own `t`. */
const translatorBinding = (module: string | undefined): string =>
  module === undefined ? '' : '\n  const t = useT();\n';

const pageSource = (surface: Surface, path: string, module: string | undefined): string => {
  const name = pascal(
    path
      .split('/')
      .filter((part) => part.length > 0)
      .at(-1) ?? 'page',
  );
  return `// Route: /${path} on the ${surface} surface. Config first: render mode, offline
// strategy and budget are declarations, not runtime choices.

${catalogImport(module)}
import { defineRoute } from '@ultimat3/render';
import styles from './page.module.scss';

export const config = defineRoute({
  render: '${RENDER[surface]}',${REVALIDATE[surface]}
  hydrate: '${HYDRATE[surface]}',
  offline: '${OFFLINE[surface]}',
  budget: ${budgetLiteral(surface)},
  meta: ({ t }) => ({
    title: t('${titleKey(path)}'),
    description: t('${titleKey(path).replace('.title', '.description')}'),
  }),
});

export function ${name}Page() {${translatorBinding(module)}
  return (
    <main class={styles.page}>
      <h1>{t('${titleKey(path)}')}</h1>
    </main>
  );
}
`;
};

const styleSource =
  (): string => `// Semantic tokens only — a raw hex here is a dark-theme bug and a lint failure.
@use '@ultimat3/ui/tokens' as tokens;

.page {
  padding: tokens.space(6);
  background: tokens.role('bg');
  color: tokens.role('fg');
}
`;

/** A value for a `[param]`, distinct per parameter so a two-param URL reads unambiguously. */
const sampleValue = (name: string): string => `${name}-1`;

/** The URL a render would actually match, with every `[param]` filled in. */
const sampleUrl = (path: string): string =>
  segmentsOf(path)
    .map((part) => {
      const name = DYNAMIC_SEGMENT.exec(part)?.groups?.['name'];
      return name === undefined ? part : sampleValue(name);
    })
    .join('/');

/** The params object that URL implies. `{}` was a lie for every dynamic route. */
const paramsLiteral = (path: string): string => {
  const params = routeParams(path);
  if (params.length === 0) return '{}';
  return `{ ${params.map((name) => `${name}: '${sampleValue(name)}'`).join(', ')} }`;
};

const routeTest = (
  surface: Surface,
  path: string,
): string => `// /${path}'s declaration, on the \`unit\` step: metadata that renders, and the render mode,
// offline strategy and budget it promises. A route with no title is an SEO regression.
import { metaContextFor, routeDataFor } from '@ultimat3/render';
import { expect, unitTest } from '@ultimat3/testing';
import { config } from './page';

// What a render gives this route: the URL it matched and the params in it. \`routeDataFor\` is the
// one resolver — with no \`load\` the context IS the data, and with one the loader decides — so a
// test asserts on the same object the page component and \`meta\` are handed in production.
const ctx = { params: ${paramsLiteral(path)}, url: 'https://example.test/${sampleUrl(path)}' };

unitTest('/${path} declares metadata', async () => {
  expect(config.kind).toBe('route');
  // meta() takes the route's data and always resolves — awaiting is the one shape, whether the
  // declaration was written sync or async.
  const meta = await config.meta(metaContextFor(ctx, await routeDataFor(config, ctx)));
  expect(meta.title ?? '').not.toBe('');
  expect(meta.description ?? '').not.toBe('');
});

unitTest('/${path} declares its render and offline strategy', () => {
  expect(config.render).toBe('${RENDER[surface]}');
  expect(config.offline).toBe('${OFFLINE[surface]}');
});

// The only budget this route declares, because it is the only one the build can weigh: nothing
// in the framework observes a paint, so an lcp budget would be a number pinned here and never
// compared against anything.
unitTest('/${path} stays inside its byte budget declaration', () => {
  expect(config.budget.js).toBe('${BUDGET[surface].js}');
});
`;

/**
 * The offline assertion, in its own file — and that is the whole point of the split. The gate
 * types a test by its FILENAME, so an `e2eTest` living in `page.test.ts` was classified as a UNIT
 * test and could never reach the `e2e` step no matter what drove it. `page.e2e.test.ts` is the
 * name the `e2e` step selects on.
 */
const routeE2eTest = (
  path: string,
): string => `// /${path} on a train: the offline fallback, asserted against the BUILT output. Its own file
// because the gate types a test by its FILENAME — an e2eTest in page.test.ts is a unit test.
import { e2eTest, expect } from '@ultimat3/testing';

// Runs under the \`e2e\` step, against the BUILT output. Without a registered browser driver
// \`e2eTest\` reports itself skipped, naming the command that builds what it would drive.
e2eTest('/${path} renders offline', async ({ page, offline }) => {
  await page.goto('/${sampleUrl(path)}');
  await offline();
  await page.reload();
  expect(await page.title()).not.toBe('');
});
`;

const catalogSource = (path: string): string =>
  catalogJson({
    [titleKey(path)]: pascal(path.split('/').at(-1) ?? 'Page'),
    [titleKey(path).replace('.title', '.description')]: 'Describe this page for search results.',
  });

export interface RouteOptions {
  readonly surface: Surface;
  /** Every locale the catalog entry ships for. Defaults to `['en']` — an app narrows or grows it. */
  readonly locales?: readonly string[];
  /**
   * The app's own catalog module — `@<app>/i18n`, read off `packages/i18n/package.json` by
   * `resolveCatalogModule`. Absent for an app that ships no such package, and only then does the
   * generated page fall back to importing `t` from `@ultimat3/i18n`.
   */
  readonly catalogModule?: string;
}

export function routeFiles(rawPath: string, options: RouteOptions): readonly GeneratedFile[] {
  const path = rawPath.replace(/^\/+/, '');
  const dir = routeDir(options.surface, path);
  const locales = resolveLocales(options.locales);
  return [
    { path: `${dir}/page.tsx`, contents: pageSource(options.surface, path, options.catalogModule) },
    { path: `${dir}/page.module.scss`, contents: styleSource() },
    { path: `${dir}/page.test.ts`, contents: routeTest(options.surface, path) },
    { path: `${dir}/page.e2e.test.ts`, contents: routeE2eTest(path) },
    ...locales.map((locale) => ({
      path: catalogPath(locale),
      contents: catalogSource(path),
      merge: 'json' as const,
    })),
  ];
}
