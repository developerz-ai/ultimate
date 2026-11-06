// The docs site's frame: one header with the four destinations, the page, and the footer every
// `[footer](_Footer)` link in the wiki lands on. Static markup, no island: every docs page is 0 KB
// of script, and this file is on every one of them.

import { useT } from '@docs-site/i18n';
import { frameworkVersion } from '@ultimat3/core';
import { Link } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { FOOTER_ANCHOR } from './docs-links';
import styles from './docs-shell.module.scss';

/** Which destination a page belongs to, so its link carries `aria-current`. */
export type DocsNav = 'manual' | 'errors' | 'upgrading' | 'search';

export interface DocsShellProps {
  readonly nav?: DocsNav | undefined;
  readonly children: JSX.Element;
}

export function DocsShell(props: DocsShellProps): JSX.Element {
  const t = useT();
  const item = (id: DocsNav, href: string, label: string): JSX.Element => (
    <li>
      <Link href={href} tone="inherit" aria-current={props.nav === id ? 'page' : false}>
        {label}
      </Link>
    </li>
  );
  return (
    <div class={styles.frame}>
      <header class={styles.header}>
        <Link class={styles.brand} href="/" tone="inherit" underline="none">
          {t('shell.brand')}
        </Link>
        <nav aria-label={t('docs.nav.label')}>
          <ul class={styles.nav}>
            {item('manual', '/docs', t('docs.nav.manual'))}
            {item('errors', '/error-codes', t('docs.nav.errors'))}
            {item('upgrading', '/upgrading', t('docs.nav.upgrading'))}
            {item('search', '/search', t('docs.nav.search'))}
          </ul>
        </nav>
      </header>
      <main class={styles.main}>{props.children}</main>
      <footer id={FOOTER_ANCHOR.slice(1)} class={styles.footer}>
        {t('docs.footer', { version: frameworkVersion() })}
      </footer>
    </div>
  );
}
