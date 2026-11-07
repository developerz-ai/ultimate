// The `blog` shape's site: the index at `/` and one page per post at `/posts/<slug>`, both `isr`
// with zero JavaScript, read over the app's own typed query client — `site/` never imports `app/`,
// so a page reaches the slice the way a stranger's client would, and the build prerenders it.

import { catalogJson } from '../catalog-json';
import { catalogPath } from '../locales';
import type { GeneratedFile, NameSet } from '../naming';

const client =
  (): string => `// The typed read client a \`site/\` page loads through. \`Api\` is a TYPE import, so no module edge
// reaches \`app/\`: the page asks its own server over HTTP, and \`x build\` answers it in process.

import { queryClient } from '@ultimat3/query';
import type { Api } from '../api';

type Env = Readonly<Record<string, string | undefined>>;

/** The origin the server reads itself through: \`APP_URL\`, or this process's own port. */
export const appUrl = (env: Env): string => env.APP_URL || \`http://localhost:\${env.PORT || '3000'}\`;

export const queries = queryClient<Api['queries']>({
  get baseUrl() {
    return appUrl(Bun.env);
  },
});
`;

const clientTest =
  (): string => `// Where the server reads itself: the one origin rule the pages' client depends on.
import { expect, unitTest } from '@ultimat3/testing';
import { appUrl } from './client';

unitTest('the server reads itself at APP_URL, or at its own port when none is set', () => {
  expect(appUrl({ APP_URL: 'https://blog.example' })).toBe('https://blog.example');
  expect(appUrl({ PORT: '4000' })).toBe('http://localhost:4000');
  expect(appUrl({})).toBe('http://localhost:3000');
});
`;

const rows =
  (): string => `// The one row a detail page renders. A read answers rows, \`limit(1)\` included; the empty answer is
// a 404 decided here rather than in every \`load\`.

import { assertCoded } from '@ultimat3/core';

export function oneRow<TRow>(found: readonly TRow[], reference: string): TRow {
  const [row] = found;
  assertCoded(
    row !== undefined,
    'X_NOT_FOUND',
    \`no published post at "\${reference}"\`,
    'bunx x db seed   # or publish the post at /admin',
  );
  return row;
}
`;

const rowsTest = (): string => `// A detail page's one row: the row, or the 404 the route answers.
import { expect, unitTest } from '@ultimat3/testing';
import { oneRow } from './rows';

unitTest('one row is the row, and none is X_NOT_FOUND', () => {
  expect(oneRow(['a'], 'a')).toBe('a');
  expect(() => oneRow([], 'missing')).toThrow(expect.objectContaining({ code: 'X_NOT_FOUND' }));
});
`;

/** One zone for every reader: an \`isr\` page is ONE document, rendered once for all of them. */
const ISR_HEAD = `  render: 'isr',
  // A post edited at /admin reaches readers within five minutes. No query parameter is part of an
  // \`isr\` page by default, so \`?utm_source=…\` cannot mint another stored copy.
  revalidate: { ttl: '5m' },
  offline: 'runtime',
  hydrate: 'never',
  budget: { js: '0kb' },`;

const indexPage = (
  app: NameSet,
): string => `// The blog index: every published post, newest first. Zero JavaScript.

import { useT } from '@${app.kebab}/i18n';
import { defineRoute } from '@ultimat3/render';
import { DateTime } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { For, Show } from 'solid-js';
import { queries } from '../shared/client';
import styles from './page.module.scss';

export const config = defineRoute({
${ISR_HEAD}
  load: async () => await queries.publishedPosts({}),
  meta: ({ t }) => ({ title: t('site.blog.title'), description: t('site.blog.description') }),
});

export type BlogIndex = Awaited<ReturnType<typeof queries.publishedPosts>>;

export function Page(props: { readonly data: BlogIndex }): JSX.Element {
  const t = useT();
  return (
    <main class={styles.page}>
      <h1>{t('site.blog.title')}</h1>
      <Show when={props.data.length > 0} fallback={<p>{t('site.blog.empty')}</p>}>
        <ul class={styles.list}>
          <For each={props.data}>
            {(post) => (
              <li class={styles.item}>
                <a href={\`/posts/\${encodeURIComponent(post.slug)}\`}>{post.title}</a>
                <Show when={post.publishedAt}>
                  {(at) => <DateTime value={at()} timeZone="UTC" dateStyle="long" />}
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </main>
  );
}
`;

/** The test helper both page tests share: the app's own HTTP answer, as the query route sends it. */
const ANSWER = `/** Every read the page makes, answered in process with \`rows\` — the query route's JSON body. */
const answering = (rows: readonly unknown[]) => async (): Promise<Response> => Response.json(rows);
`;

const indexTest = (
  app: NameSet,
): string => `// The blog index: what it links, its empty state, its zero-JS contract and its read.
import { useT } from '@${app.kebab}/i18n';
import { withInProcessFetch } from '@ultimat3/core';
import { expect, renderRoute, renderView, unitTest } from '@ultimat3/testing';
import * as page from './page';
import { config, Page } from './page';

${ANSWER}
const post = { slug: 'hello world', title: 'Hello', body: 'b', id: 'p1' };

unitTest('the index links every post by its slug, newest first as the read answers', async () => {
  const at = new Date('2026-01-01T00:00:00Z');
  const view = await renderView(Page, {
    data: [
      { ...post, publishedAt: at, createdAt: at },
      { ...post, slug: 'two', title: 'Two', publishedAt: at, createdAt: at },
    ],
  });
  const hrefs = [...view.html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
  expect(hrefs).toEqual(['/posts/hello%20world', '/posts/two']);
  expect(view.text).toContain('Hello');
});

unitTest('no post is an empty state, not an empty list', async () => {
  const view = await renderView(Page, { data: [] });
  expect(view.text).toContain(useT()('site.blog.empty'));
  expect(view.html).not.toContain('<ul');
});

unitTest('it is isr with zero JavaScript', () => {
  expect(config.render).toBe('isr');
  expect(config.hydrate).toBe('never');
  expect(config.budget.js).toBe('0kb');
});

unitTest('load reads the published posts through the typed client', async () => {
  const rows = [{ ...post, publishedAt: null, createdAt: null }];
  const view = await withInProcessFetch(answering(rows), () => renderRoute(page));
  expect(view.data.map((row) => row.slug)).toEqual(['hello world']);
  expect(view.meta.title).toBe(useT()('site.blog.title'));
});
`;

const postPage = (
  app: NameSet,
): string => `// One published post. Prerendered at build for every published slug, then regenerated on read.

import { useT } from '@${app.kebab}/i18n';
import { defineRoute } from '@ultimat3/render';
import { DateTime } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { Show } from 'solid-js';
import { queries } from '../../../shared/client';
import { oneRow } from '../../../shared/rows';
import styles from './page.module.scss';

export const config = defineRoute({
${ISR_HEAD}
  prerender: async () => (await queries.publishedPosts({ limit: 50 })).map((post) => post.slug),
  load: async ({ params }) => {
    const slug = params.slug ?? '';
    return oneRow(await queries.publishedPost({ slug }), slug);
  },
  meta: ({ data }) => ({ title: data.title, description: data.body.slice(0, 160) }),
});

export type BlogPost = Awaited<ReturnType<typeof queries.publishedPost>>[number];

export function Page(props: { readonly data: BlogPost }): JSX.Element {
  const t = useT();
  return (
    <main class={styles.page}>
      <article>
        <h1>{props.data.title}</h1>
        <Show when={props.data.publishedAt}>
          {(at) => <DateTime value={at()} timeZone="UTC" dateStyle="long" />}
        </Show>
        <p class={styles.body}>{props.data.body}</p>
      </article>
      <a href="/">{t('site.blog.back')}</a>
    </main>
  );
}
`;

const postTest = (
  app: NameSet,
): string => `// One post: what it renders, which slugs the build prerenders, and the 404 for the rest.
import { useT } from '@${app.kebab}/i18n';
import { withInProcessFetch } from '@ultimat3/core';
import { expect, renderRoute, renderView, unitTest } from '@ultimat3/testing';
import * as page from './page';
import { config, Page } from './page';

${ANSWER}
unitTest('a post renders its title, its body and the way back', async () => {
  const at = new Date('2026-01-01T00:00:00Z');
  const data = {
    id: 'p1',
    slug: 'hello',
    title: 'Hello',
    body: 'The body.',
    publishedAt: at,
    createdAt: at,
  };
  const view = await renderView(Page, { data });
  expect(view.html.match(/<h1\\b/g)).toHaveLength(1);
  expect(view.text).toContain('The body.');
  expect(view.text).toContain(useT()('site.blog.back'));
});

unitTest('it is isr with zero JavaScript', () => {
  expect(config.render).toBe('isr');
  expect(config.budget.js).toBe('0kb');
});

unitTest('prerender lists every published slug, and load renders one post', async () => {
  const row = {
    id: 'p1',
    slug: 'hello',
    title: 'Hello',
    body: 'b',
    publishedAt: null,
    createdAt: null,
  };
  const slugs = await withInProcessFetch(answering([row]), () => config.prerender?.());
  expect(slugs).toEqual(['hello']);
  const view = await withInProcessFetch(answering([row]), () =>
    renderRoute(page, { params: { slug: 'hello' } }),
  );
  expect(view.meta.title).toBe('Hello');
});

unitTest('a slug no published post has is X_NOT_FOUND', async () => {
  const missing = withInProcessFetch(answering([]), () =>
    renderRoute(page, { params: { slug: 'gone' } }),
  );
  await expect(missing).rejects.toThrow(expect.objectContaining({ code: 'X_NOT_FOUND' }));
});
`;

const style = (): string => `@use '@ultimat3/ui/tokens' as tokens;

.page {
  display: grid;
  gap: tokens.space(4);
  padding: tokens.space(8);
  background: tokens.role('bg');
  color: tokens.role('fg');
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

const postStyle = (): string => `@use '@ultimat3/ui/tokens' as tokens;

.page {
  display: grid;
  gap: tokens.space(4);
  padding: tokens.space(8);
  background: tokens.role('bg');
  color: tokens.role('fg');
}

.body {
  white-space: pre-line;
}
`;

/** `shared/` helpers and the two pages, with the catalog keys they read. */
export function blogSiteFiles(app: NameSet): readonly GeneratedFile[] {
  return [
    { path: 'apps/web/shared/client.ts', contents: client() },
    { path: 'apps/web/shared/client.test.ts', contents: clientTest() },
    { path: 'apps/web/shared/rows.ts', contents: rows() },
    { path: 'apps/web/shared/rows.test.ts', contents: rowsTest() },
    { path: 'apps/web/site/page.tsx', contents: indexPage(app) },
    { path: 'apps/web/site/page.test.ts', contents: indexTest(app) },
    { path: 'apps/web/site/page.module.scss', contents: style() },
    { path: 'apps/web/site/posts/[slug]/page.tsx', contents: postPage(app) },
    { path: 'apps/web/site/posts/[slug]/page.test.ts', contents: postTest(app) },
    { path: 'apps/web/site/posts/[slug]/page.module.scss', contents: postStyle() },
    {
      path: catalogPath('en'),
      merge: 'json',
      contents: catalogJson({
        'site.blog.title': app.pascal,
        'site.blog.description': `Posts from ${app.pascal}.`,
        'site.blog.empty': 'Nothing published yet. Write the first post at /admin.',
        'site.blog.back': 'All posts',
        // The labels \`/admin\` renders for the \`posts\` screens it derives from the entity.
        'admin.posts.title': 'Posts',
        'admin.posts.field.id': 'ID',
        'admin.posts.field.slug': 'Slug',
        'admin.posts.field.title': 'Title',
        'admin.posts.field.body': 'Body',
        'admin.posts.field.publishedAt': 'Published at',
        'admin.posts.field.createdAt': 'Created at',
      }),
    },
  ];
}
