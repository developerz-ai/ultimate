// One page per `X_*` code: `/errors/X_DB_DRIFT` is its row in `wiki/Error-Codes.md` — what it
// means, the typical cause, the fix — under the column headers the wiki table itself carries. A
// code two sections describe shows both rows. The URL an error's `docs:` can point at, one day.

import { clipText, plainText, siblingPath } from '@docs-site/docs-source';
import { useT } from '@docs-site/i18n';
import { assertCoded } from '@ultimat3/core';
import { defineRoute } from '@ultimat3/render';
import { DESCRIPTION_MAX_LENGTH, ld } from '@ultimat3/seo';
import { Link } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { For } from 'solid-js';
import { DocBody } from '../../../shared/doc-body';
import { codePage, docsCorpus } from '../../../shared/docs';
import { DocsShell } from '../../../shared/docs-shell';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'static',
  hydrate: 'never',
  // `runtime`: a dynamic route has no one URL to precache; each page is cached once visited.
  offline: 'runtime',
  budget: { js: '0kb' },
  prerender: async () => (await docsCorpus()).codes.map((piece) => piece.code),
  load: async ({ params }) => {
    const code = params.code ?? '';
    const piece = await codePage(code);
    assertCoded(
      piece !== undefined,
      'X_NOT_FOUND',
      `no page is built for ${code}`,
      'bunx x errors explain X_DB_DRIFT --json   # a code has a page once wiki/Error-Codes.md has its row',
    );
    return piece;
  },
  meta: ({ data, t, url }) => ({
    title: data.code,
    description: clipText(
      plainText(
        t('docs.code.metaDescription', {
          code: data.code,
          means: data.rows[0]?.cells[0]?.markdown ?? '',
        }),
      ),
      DESCRIPTION_MAX_LENGTH - 1,
    ),
    canonical: url,
    ld: [
      ld.BreadcrumbList({
        items: [
          { name: t('docs.breadcrumbHome'), url: '/' },
          { name: t('docs.nav.errors'), url: '/error-codes' },
          { name: data.code, url },
        ],
      }),
    ],
  }),
});

type Piece = NonNullable<Awaited<ReturnType<typeof codePage>>>;

export function Page(props: { readonly data: Piece }): JSX.Element {
  const t = useT();
  return (
    <DocsShell nav="errors">
      <article class={styles.article}>
        <h1 class={styles.code}>{props.data.code}</h1>
        <For each={props.data.rows}>
          {(row) => (
            <section class={styles.row}>
              <For each={row.cells}>
                {(cell) => (
                  <>
                    <h2 class={styles.label}>{cell.label}</h2>
                    <DocBody markdown={cell.markdown} />
                  </>
                )}
              </For>
              <p class={styles.listed}>
                <Link href={row.section.url}>
                  {t('docs.code.listed', { section: row.section.title })}
                </Link>
              </p>
            </section>
          )}
        </For>
        <p class={styles.listed}>
          <Link href={`/${siblingPath(props.data.url)}`}>{t('docs.markdown')}</Link>
        </p>
      </article>
    </DocsShell>
  );
}
