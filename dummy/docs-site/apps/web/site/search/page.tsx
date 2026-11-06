// `/search`: the one page of this site that ships script, and exactly one module of it — the
// island below, which ranks the static index with `searchDocs`. The form, the status line and the
// result list are server markup; every other page stays 0 KB.

import { useT } from '@docs-site/i18n';
import { defineRoute, island } from '@ultimat3/render';
import type { JSX } from 'solid-js';
import { SEARCH_INDEX_PATH } from '../../shared/docs-links';
import { DocsShell } from '../../shared/docs-shell';
import styles from './page.module.scss';

const Search = island({
  src: './search.island.tsx',
  props: ['indexPath', 'loadingLabel', 'emptyLabel', 'failedLabel'],
});

export const config = defineRoute({
  render: 'static',
  // `idle`, not `interaction`: a pasted `/search?q=…` runs its query on arrival, with no click.
  hydrate: 'idle',
  offline: 'precache',
  // measured: 17565 B (2026-11-06; `x verify --only budgets`): the island chunk 15,753 + the inline
  // runtime 1,812 — why: the island ranks with `searchDocs` and its tokenizer
  // (`@ultimat3/manifest/docs-search`, a few kB) and reads the static index through core's one
  // browser transport, `clientTransport`, which is most of the rest. The only script on this site.
  budget: { js: '18kb' },
  meta: ({ t, url }) => ({
    title: t('docs.search.title'),
    description: t('docs.search.description'),
    canonical: url,
  }),
});

export function Page(): JSX.Element {
  const t = useT();
  return (
    <DocsShell nav="search">
      <h1 class={styles.title}>{t('docs.search.title')}</h1>
      <Search
        indexPath={SEARCH_INDEX_PATH}
        loadingLabel={t('docs.search.loading')}
        emptyLabel={t('docs.search.empty')}
        failedLabel={t('docs.search.failed')}
      >
        <search>
          <form class={styles.form} action="/search" method="get">
            <label class={styles.label} for="q">
              {t('docs.search.label')}
            </label>
            <input
              class={styles.input}
              id="q"
              name="q"
              type="search"
              placeholder={t('docs.search.placeholder')}
            />
            <button class={styles.submit} type="submit">
              {t('docs.search.submit')}
            </button>
          </form>
        </search>
        <p class={styles.status} data-role="status" aria-live="polite">
          <noscript>{t('docs.search.noScript')}</noscript>
        </p>
        <ol class={styles.results} data-role="results" />
      </Search>
    </DocsShell>
  );
}
