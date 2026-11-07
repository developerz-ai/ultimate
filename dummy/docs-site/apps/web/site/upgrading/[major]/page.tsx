// One page per major in `wiki/Upgrading.md`: `/upgrading/30` is every entry of `29.x → 30.0.0`.
// The wiki keeps one 380 KB file; split here, "how do I move to 30" is one URL and one screen.

import { assertCoded } from '@ultimat3/core';
import { defineRoute } from '@ultimat3/render';
import { ld } from '@ultimat3/seo';
import type { JSX } from 'solid-js';
import { DocArticle } from '../../../shared/doc-article';
import { docPage, docsCorpus } from '../../../shared/docs';

export const config = defineRoute({
  render: 'static',
  hydrate: 'never',
  // `runtime`: a dynamic route has no one URL to precache; each page is cached once visited.
  offline: 'runtime',
  budget: { js: '0kb' },
  prerender: async () => (await docsCorpus()).majors.map((piece) => String(piece.major)),
  load: async ({ params }) => {
    const url = `/upgrading/${params.major ?? ''}`;
    const piece = await docPage(url);
    assertCoded(
      piece !== undefined,
      'X_NOT_FOUND',
      `no upgrade notes are built at ${url}`,
      "grep -n '^## .*→' ../../wiki/Upgrading.md   # each major is one `## N.x → M.0.0` heading",
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
          { name: t('docs.nav.upgrading'), url: '/upgrading' },
          { name: data.title, url },
        ],
      }),
    ],
  }),
});

type Piece = NonNullable<Awaited<ReturnType<typeof docPage>>>;

export function Page(props: { readonly data: Piece }): JSX.Element {
  return <DocArticle piece={props.data} nav="upgrading" />;
}
