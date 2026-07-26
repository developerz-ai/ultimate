// `x g route <path>` — a URL, its render mode, its metadata, its offline strategy and its budget.
// The generated test pins metadata presence and the offline fallback: a route with no title is an
// SEO regression and a route with no fallback is a blank screen on a train.

import type { GeneratedFile } from './naming';
import { kebab, pascal, titleKey } from './naming';

export type Surface = 'site' | 'app';

const RENDER: Record<Surface, string> = { site: 'isr', app: 'stream' };
const HYDRATE: Record<Surface, string> = { site: 'never', app: 'visible' };
const OFFLINE: Record<Surface, string> = { site: 'precache', app: 'runtime' };
const BUDGET: Record<Surface, string> = {
  site: "{ js: '0kb', lcp: 1800 }",
  app: "{ js: '60kb', lcp: 2500 }",
};

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
import { defineRoute } from '@ultimat3/render';
import { t } from '@ultimat3/i18n';
import styles from './page.module.scss';

export const config = defineRoute({
  kind: 'route',
  render: '${RENDER[surface]}',
  hydrate: '${HYDRATE[surface]}',
  offline: '${OFFLINE[surface]}',
  budget: ${BUDGET[surface]},
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
  padding: tokens.$space-6;
  background: tokens.$surface-base;
  color: tokens.$text-primary;
}
`;

const routeTest = (surface: Surface, path: string): string => `import { expect } from 'bun:test';
import { e2eTest, unitTest } from '@ultimat3/testing';
import { config } from './page';

unitTest('/${path} declares metadata', () => {
  const meta = config.meta();
  expect(meta.title.length).toBeGreaterThan(0);
  expect(meta.description.length).toBeGreaterThan(0);
});

unitTest('/${path} declares a render mode, an offline strategy and a budget', () => {
  expect(config.render).toBe('${RENDER[surface]}');
  expect(config.offline).toBe('${OFFLINE[surface]}');
  expect(config.budget).toBeDefined();
});

unitTest('/${path} stays inside its byte budget declaration', () => {
  expect(config.budget.js).toBe('${surface === 'site' ? '0kb' : '60kb'}');
});

e2eTest('/${path} renders offline from its fallback', async ({ page, offline }) => {
  await page.goto('/${path}');
  await offline();
  await page.reload();
  expect(await page.title()).not.toBe('');
});
`;

const catalogSource = (path: string): string => `{
  "${titleKey(path)}": "${pascal(path.split('/').at(-1) ?? 'Page')}",
  "${titleKey(path).replace('.title', '.description')}": "Describe this page for search results."
}
`;

export interface RouteOptions {
  readonly surface: Surface;
}

export function routeFiles(rawPath: string, options: RouteOptions): readonly GeneratedFile[] {
  const path = rawPath.replace(/^\/+/, '');
  const dir = routeDir(options.surface, path);
  return [
    { path: `${dir}/page.tsx`, contents: pageSource(options.surface, path) },
    { path: `${dir}/page.module.scss`, contents: styleSource() },
    { path: `${dir}/page.test.ts`, contents: routeTest(options.surface, path) },
    { path: `packages/i18n/catalogs/en/${kebab(path)}.json`, contents: catalogSource(path) },
  ];
}
