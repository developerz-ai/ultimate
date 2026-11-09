// One manual page per `wiki/*.md` file: `/getting-started`, `/cli-reference`, `/docs` for the
// wiki's Home. Static, 0 KB: the body is markdown rendered on the server, links already rewritten
// to this site by the reader. The two split pages (`/error-codes`, `/upgrading`) are indexes here.

import { assertCoded } from '@ultimat3/core';
import { defineRoute } from '@ultimat3/render';
import { ld } from '@ultimat3/seo';
import type { JSX } from 'solid-js';
import { DocArticle } from '../../shared/doc-article';
import { docPage, docsCorpus } from '../../shared/docs';
import type { DocsNav } from '../../shared/docs-shell';

const NAV = new Map<string, DocsNav>([
  ['/error-codes', 'errors'],
  ['/upgrading', 'upgrading'],
]);

export const config = defineRoute({
  render: 'static',
  hydrate: 'never',
  // `runtime`: a dynamic route has no one URL to precache; each page is cached once visited.
  offline: 'runtime',
  budget: { js: '0kb' },
  prerender: async () => (await docsCorpus()).pages.map((piece) => piece.url.slice(1)),
  load: async ({ params }) => {
    const url = `/${params.page ?? ''}`;
    const piece = await docPage(url);
    assertCoded(
      piece !== undefined,
      'X_NOT_FOUND',
      `no wiki page is built at ${url}`,
      'ls ../../wiki   # a page is a wiki/<Name>.md file; its URL is /<name>, lowercased',
    );
    return piece;
  },
  meta: ({ data, t, url }) => ({
    title: data.title,
    description: data.lead,
    canonical: url,
    ld: [
      ld.BreadcrumbList({
        items: [
          { name: t('docs.breadcrumbHome'), url: '/' },
          { name: data.title, url },
        ],
      }),
    ],
  }),
});

type Piece = NonNullable<Awaited<ReturnType<typeof docPage>>>;

export function Page(props: { readonly data: Piece }): JSX.Element {
  return <DocArticle piece={props.data} nav={NAV.get(props.data.url) ?? 'manual'} />;
}
