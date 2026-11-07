// A wiki piece as a page: its title as the one `h1`, the body, and the two ways out — the wiki
// file to edit and the same page as markdown. Shared by the manual pages and the upgrade majors.

import type { DocPiece } from '@docs-site/docs-source';
import { siblingPath } from '@docs-site/docs-source';
import { useT } from '@docs-site/i18n';
import { Link } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import styles from './doc-article.module.scss';
import { DocBody } from './doc-body';
import { wikiSourceUrl } from './docs-links';
import { type DocsNav, DocsShell } from './docs-shell';

export function DocArticle(props: {
  readonly piece: DocPiece;
  readonly nav: DocsNav;
}): JSX.Element {
  const t = useT();
  return (
    <DocsShell nav={props.nav}>
      <article class={styles.article}>
        <h1 class={styles.title}>{props.piece.title}</h1>
        <DocBody markdown={props.piece.markdown} />
        <p class={styles.ways}>
          <Link href={wikiSourceUrl(props.piece.file)} external>
            {t('docs.source')}
          </Link>
          <Link href={`/${siblingPath(props.piece.url)}`}>{t('docs.markdown')}</Link>
        </p>
      </article>
    </DocsShell>
  );
}
