// `x g route <path>` — a URL, its render mode, its metadata, its offline strategy and its budget.
// The generated test pins metadata presence and the offline fallback: a route with no title is an
// SEO regression and a route with no fallback is a blank screen on a train.

import { catalogJson } from './catalog-json';
import { catalogPath, resolveLocales } from './locales';
import type { GeneratedFile } from './naming';
import { kebab, pascal, titleKey } from './naming';

export type Surface = 'site' | 'app';

const RENDER: Record<Surface, string> = { site: 'isr', app: 'stream' };
const HYDRATE: Record<Surface, string> = { site: 'never', app: 'visible' };
const OFFLINE: Record<Surface, string> = { site: 'precache', app: 'runtime' };
/** Structured, not a literal string: the route and the test that pins it read the same fact. */
const BUDGET: Record<Surface, { readonly js: string; readonly lcp: number }> = {
  site: { js: '0kb', lcp: 1800 },
  app: { js: '60kb', lcp: 2500 },
};
const budgetLiteral = (surface: Surface): string =>
  `{ js: '${BUDGET[surface].js}', lcp: ${BUDGET[surface].lcp} }`;
/** `isr` without a trigger is `static` wearing a costume — @ultimat3/render rejects it at boot. */
const REVALIDATE: Record<Surface, string> = { site: "\n  revalidate: { ttl: '1h' },", app: '' };

const routeDir = (surface: Surface, path: string): string =>
  `apps/web/${surface}/${path
    .split('/')
    .filter((part) => part.length > 0)
    .map(kebab)
    .join('/')}`;

const pageSource = (surface: Surface, path: string): string => {
  const name = pascal(
    path
      .split('/')
      .filter((part) => part.length > 0)
      .at(-1) ?? 'page',
  );
  return `// Route: /${path} on the ${surface} surface. Config first: render mode, offline
// strategy and budget are declarations, not runtime choices.

import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import styles from './page.module.scss';

export const config = defineRoute({
  render: '${RENDER[surface]}',${REVALIDATE[surface]}
  hydrate: '${HYDRATE[surface]}',
  offline: '${OFFLINE[surface]}',
  budget: ${budgetLiteral(surface)},
  meta: () => ({
    title: t('${titleKey(path)}'),
    description: t('${titleKey(path).replace('.title', '.description')}'),
  }),
});

export function ${name}Page() {
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

const routeTest = (
  surface: Surface,
  path: string,
): string => `import { e2eTest, expect, unitTest } from '@ultimat3/testing';
import { config } from './page';

unitTest('/${path} declares metadata', async () => {
  expect(config.kind).toBe('route');
  // meta() takes the route's data and always resolves — awaiting is the one shape, whether the
  // declaration was written sync or async.
  const meta = await config.meta({});
  expect(meta.title ?? '').not.toBe('');
  expect(meta.description ?? '').not.toBe('');
});

unitTest('/${path} declares a render mode, an offline strategy and a budget', () => {
  expect(config.render).toBe('${RENDER[surface]}');
  expect(config.offline).toBe('${OFFLINE[surface]}');
  // budget is always on the descriptor, so pin the number: presence cannot fail.
  expect(config.budget.lcp).toBe(${BUDGET[surface].lcp});
});

unitTest('/${path} stays inside its byte budget declaration', () => {
  expect(config.budget.js).toBe('${BUDGET[surface].js}');
});

e2eTest('/${path} renders offline from its fallback', async ({ page, offline }) => {
  await page.goto('/${path}');
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
}

export function routeFiles(rawPath: string, options: RouteOptions): readonly GeneratedFile[] {
  const path = rawPath.replace(/^\/+/, '');
  const dir = routeDir(options.surface, path);
  const locales = resolveLocales(options.locales);
  return [
    { path: `${dir}/page.tsx`, contents: pageSource(options.surface, path) },
    { path: `${dir}/page.module.scss`, contents: styleSource() },
    { path: `${dir}/page.test.ts`, contents: routeTest(options.surface, path) },
    ...locales.map((locale) => ({
      path: catalogPath(locale),
      contents: catalogSource(path),
      merge: 'json' as const,
    })),
  ];
}
