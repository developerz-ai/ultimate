// The `content` shape's `site/`: the front page at `/` listing every page, and one page per
// markdown file at `/<slug>`, both `render: 'static'` with zero JavaScript, each built once per
// routed locale (`/es/<slug>`) inside one frame that links the other languages.

import type { GeneratedFile, NameSet } from '../naming';

const frame = (
  app: NameSet,
): string => `// The chrome every page wears: the site's name home, the page in each language, and the body.
// Server-rendered links only — a language switch is a link to the other copy, never a script.

// The app's catalogs declare which locales are routed: imported here, by the one module that reads
// them, so the frame links every language whoever loads it first — a page, or this file's test alone.
import '@${app.kebab}/i18n';
import { routedLocales } from '@ultimat3/i18n';
import { LocaleSwitcher } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import styles from './site-frame.module.scss';

/** A proper noun, the same in every language — never a catalog string. */
export const SITE_NAME = '${app.pascal}';

export function SiteFrame(props: {
  /** The locale this copy renders in. */
  readonly locale: string;
  /** Where the site's name links: the front page in this locale. */
  readonly home: string;
  /** This page's path, unprefixed: the switcher links it in every routed locale. */
  readonly path: string;
  readonly children: JSX.Element;
}): JSX.Element {
  return (
    <div class={styles.frame}>
      <header class={styles.header}>
        <a class={styles.brand} href={props.home}>
          {SITE_NAME}
        </a>
        <LocaleSwitcher locales={routedLocales()} value={props.locale} path={props.path} />
      </header>
      <main class={styles.main}>{props.children}</main>
    </div>
  );
}
`;

const frameTest =
  (): string => `// The frame: the site's name links home, and every routed locale is one link to this page.
import { expect, renderView, unitTest } from '@ultimat3/testing';
import { SITE_NAME, SiteFrame } from './site-frame';

unitTest('the name links home, and each language links this page in it', async () => {
  const view = await renderView(SiteFrame, {
    locale: 'en',
    home: '/',
    path: '/about',
    children: 'body',
  });
  const hrefs = [...view.html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
  expect(hrefs).toEqual(['/', '/about', '/es/about']);
  expect(view.text).toContain(SITE_NAME);
  expect(view.text).toContain('body');
});
`;

const frameStyle = (): string => `@use '@ultimat3/ui/tokens' as tokens;

.frame {
  background: tokens.role('bg');
  color: tokens.role('fg');
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: tokens.space(4);
  padding: tokens.space(4) tokens.space(8);
  border-bottom: 1px solid tokens.role('line');
}

.brand {
  font-weight: tokens.weight('medium');
  color: tokens.role('fg-strong');
  text-decoration: none;
}

.main {
  @include tokens.view-transition-name(site-main);

  position: relative;
  isolation: isolate;
  display: grid;
  gap: tokens.space(4);
  padding: tokens.space(8);
}
`;

/** What both pages declare: built once per locale at `x build --target static`, no script. */
const STATIC_HEAD = `  render: 'static',
  hydrate: 'never',
  budget: { js: '0kb' },`;

const indexPage = (
  app: NameSet,
): string => `// The front page: what the site is, and every page it holds in this locale. Zero JavaScript.

import { useT } from '@${app.kebab}/i18n';
import { Aurora } from '@ultimat3/effects';
import { currentLocale, localizedPath } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import { ld } from '@ultimat3/seo';
import type { JSX } from 'solid-js';
import { For } from 'solid-js';
import { contentPages } from '../shared/content';
import { SITE_NAME, SiteFrame } from '../shared/site-frame';
import styles from './page.module.scss';

export const config = defineRoute({
${STATIC_HEAD}
  offline: 'precache',
  load: async () => {
    const locale = currentLocale();
    const pages = await contentPages(locale);
    return {
      locale,
      home: localizedPath('/', locale),
      pages: pages.map((page) => ({ ...page, href: localizedPath(\`/\${page.slug}\`, locale) })),
    };
  },
  meta: ({ t, url }) => ({
    title: t('site.content.title', { name: SITE_NAME }),
    description: t('site.content.description'),
    canonical: url,
    ld: [ld.WebSite({ name: SITE_NAME, url })],
  }),
});

export type FrontPage = Awaited<ReturnType<NonNullable<typeof config.load>>>;

export function Page(props: { readonly data: FrontPage }): JSX.Element {
  const t = useT();
  return (
    <SiteFrame locale={props.data.locale} home={props.data.home} path="/">
      <Aurora class={styles.aurora} />
      <h1>{t('site.content.headline')}</h1>
      <p class={styles.lede}>{t('site.content.lede')}</p>
      <h2>{t('site.content.pages')}</h2>
      <ul class={styles.list}>
        <For each={props.data.pages}>
          {(page) => (
            <li class={styles.item}>
              <a href={page.href}>{page.title}</a>
              <p>{page.lead}</p>
            </li>
          )}
        </For>
      </ul>
    </SiteFrame>
  );
}
`;

const indexTest = (
  app: NameSet,
): string => `// The front page: what it links in each locale, its zero-JS contract and its metadata.
import { useT } from '@${app.kebab}/i18n';
import { ctxOf, runWithContext } from '@ultimat3/core';
import { expect, renderRoute, unitTest } from '@ultimat3/testing';
import * as page from './page';

const url = 'https://example.test/';
const pageLinks = (html: string): string[] =>
  [...html.matchAll(/<li[^>]*><a href="([^"]*)"/g)].map((match) => match[1] ?? '');

unitTest('it lists every page of its locale under one h1, with no missing string', async () => {
  const t = useT();
  const view = await renderRoute(page, { url });
  expect(view.html.match(/<h1\\b/g)).toHaveLength(1);
  expect(view.text).toContain(t('site.content.headline'));
  expect(pageLinks(view.html)).toEqual(['/about', '/getting-started']);
  expect(view.text).not.toContain('⟦');
});

unitTest('the Spanish copy links the Spanish pages, in Spanish', async () => {
  const view = await runWithContext(ctxOf({ locale: 'es' }), () => renderRoute(page, { url }));
  expect(pageLinks(view.html)).toEqual(['/es/about', '/es/getting-started']);
  expect(view.data.home).toBe('/es/');
  expect(view.text).not.toContain('⟦');
  expect(view.text).not.toContain(useT()('site.content.headline'));
});

unitTest('it is static, ships zero JavaScript, and says what the site is', async () => {
  const t = useT();
  const view = await renderRoute(page, { url });
  expect(page.config.render).toBe('static');
  expect(page.config.hydrate).toBe('never');
  expect(page.config.budget.js).toBe('0kb');
  expect(view.islands).toEqual([]);
  expect(view.meta.description).toBe(t('site.content.description'));
  expect(view.meta.ld).toHaveLength(1);
});
`;

const indexStyle = (): string => `@use '@ultimat3/ui/tokens' as tokens;

// The backdrop is CSS alone (\`data-effect-backend="css"\`): zero JavaScript, behind the frame's main.
.aurora {
  position: absolute;
  inset: 0;
  z-index: -1;
}

.lede {
  color: tokens.role('fg-muted');
}

.list {
  display: grid;
  gap: tokens.space(3);
  padding: 0;
  list-style: none;
}

.item {
  display: grid;
  gap: tokens.space(1);
  color: tokens.role('fg-muted');
}
`;

const contentRoute = (
  app: NameSet,
): string => `// One page per markdown file: \`apps/web/content/en/about.md\` is \`/about\`, its Spanish copy
// \`/es/about\`. Static, 0 KB: the body is markdown rendered on the server, through \`Markdown\`.

import { useT } from '@${app.kebab}/i18n';
import { currentLocale, localizedPath, routedLocales } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import { ld } from '@ultimat3/seo';
import { Markdown } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { contentPage, contentPages } from '../../shared/content';
import { SiteFrame } from '../../shared/site-frame';

export const config = defineRoute({
${STATIC_HEAD}
  // \`runtime\`: a dynamic route has no one URL to precache; each page is cached once visited.
  offline: 'runtime',
  // The default locale's files name the pages; every other locale renders the same slugs, and one
  // missing there stops the build with X_NOT_FOUND naming the file.
  prerender: async () =>
    (await contentPages(routedLocales()[0] ?? currentLocale())).map((page) => page.slug),
  load: async ({ params }) => {
    const locale = currentLocale();
    const page = await contentPage(locale, params.page ?? '');
    return { ...page, home: localizedPath('/', locale) };
  },
  meta: ({ data, t, url }) => ({
    title: data.title,
    description: data.lead,
    canonical: url,
    ld: [
      ld.BreadcrumbList({
        items: [
          { name: t('site.content.home'), url: data.home },
          { name: data.title, url },
        ],
      }),
    ],
  }),
});

export type ContentRoute = Awaited<ReturnType<NonNullable<typeof config.load>>>;

export function Page(props: { readonly data: ContentRoute }): JSX.Element {
  const t = useT();
  return (
    <SiteFrame locale={props.data.locale} home={props.data.home} path={\`/\${props.data.slug}\`}>
      <article>
        <h1>{props.data.title}</h1>
        <Markdown text={props.data.body} baseLevel={1} />
      </article>
      <a href={props.data.home}>{t('site.content.back')}</a>
    </SiteFrame>
  );
}
`;

const contentRouteTest = (
  app: NameSet,
): string => `// One page: which slugs the build renders, what a file becomes, its Spanish copy, and the 404.
import { useT } from '@${app.kebab}/i18n';
import { ctxOf, runWithContext } from '@ultimat3/core';
import { expect, renderRoute, unitTest } from '@ultimat3/testing';
import * as page from './page';

const url = 'https://example.test/about';

unitTest('the build renders one page per file of the default locale', async () => {
  expect(await page.config.prerender?.()).toEqual(['about', 'getting-started']);
});

unitTest('a file renders its title once, its body, and the way back', async () => {
  const view = await renderRoute(page, { url, params: { page: 'getting-started' } });
  expect(view.html.match(/<h1\\b/g)).toHaveLength(1);
  expect(view.html).toContain('<h2');
  expect(view.meta.title).toBe(view.data.title);
  expect(view.meta.description).toBe(view.data.lead);
  expect(view.text).toContain(useT()('site.content.back'));
  expect(view.text).not.toContain('⟦');
});

unitTest('the Spanish copy reads the Spanish file', async () => {
  const english = await renderRoute(page, { url, params: { page: 'about' } });
  const spanish = await runWithContext(ctxOf({ locale: 'es' }), () =>
    renderRoute(page, { url, params: { page: 'about' } }),
  );
  expect(spanish.data.locale).toBe('es');
  expect(spanish.data.home).toBe('/es/');
  expect(spanish.data.title).not.toBe(english.data.title);
  expect(spanish.text).not.toContain('⟦');
});

unitTest('it is static with zero JavaScript, and a slug no file has is X_NOT_FOUND', async () => {
  expect(page.config.render).toBe('static');
  expect(page.config.budget.js).toBe('0kb');
  await expect(renderRoute(page, { url, params: { page: 'gone' } })).rejects.toThrow(
    expect.objectContaining({ code: 'X_NOT_FOUND' }),
  );
});
`;

const contentRouteE2e =
  (): string => `// A built page in a real browser, in the second locale: the document a static host serves.
import { e2eTest, expect } from '@ultimat3/testing';

e2eTest('/es/about loads in a browser and names itself', async ({ page }) => {
  await page.goto('/es/about');
  expect(await page.title()).not.toBe('');
});
`;

/** The frame, the two routes, their tests and styles. */
export function contentSiteFiles(app: NameSet): readonly GeneratedFile[] {
  return [
    { path: 'apps/web/shared/site-frame.tsx', contents: frame(app) },
    { path: 'apps/web/shared/site-frame.test.ts', contents: frameTest() },
    { path: 'apps/web/shared/site-frame.module.scss', contents: frameStyle() },
    { path: 'apps/web/site/page.tsx', contents: indexPage(app) },
    { path: 'apps/web/site/page.test.ts', contents: indexTest(app) },
    { path: 'apps/web/site/page.module.scss', contents: indexStyle() },
    { path: 'apps/web/site/[page]/page.tsx', contents: contentRoute(app) },
    { path: 'apps/web/site/[page]/page.test.ts', contents: contentRouteTest(app) },
    { path: 'apps/web/site/[page]/page.e2e.test.ts', contents: contentRouteE2e() },
  ];
}
