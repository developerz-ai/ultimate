// The frame every page in this app renders inside: skip link, header, one `<main>`, footer.
//
// It lives in `shared/` because both surfaces need it and `shared/` is the only leaf both may
// import — `site/` reaching into `app/` for a header would put the app graph's bytes on a 0kb page.
// The shell owns the `<main>` landmark and the content measure, so a page component returns its
// content and never its own landmark: twelve hand-rolled `<main>`s is twelve chances to ship two.

import { t } from '@ultimat3/i18n';
import type { JSX } from 'solid-js';
import styles from './app-shell.module.scss';
import { pathnameOf } from './nav';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';
import { viewerIsOperator, viewerIsSignedIn } from './viewer';

/** `prose` is the reading measure, `wide` the two-column screens, `full` the landing page's bands. */
export type ShellWidth = 'prose' | 'wide' | 'full';

export interface AppShellProps {
  /** The page's own url, as the renderer hands it to a route component. Drives `aria-current`. */
  readonly url?: string | undefined;
  readonly width?: ShellWidth | undefined;
  readonly children?: JSX.Element;
}

/** The skip link's target. A constant, because the link and the landmark must never disagree. */
const MAIN_ID = 'main';

export function AppShell(props: AppShellProps): JSX.Element {
  const width = props.width ?? 'prose';
  // Read once and handed to both bars: two reads is two answers the moment one of them is cached.
  const signedIn = viewerIsSignedIn();
  const operator = viewerIsOperator();

  return (
    <div class={styles.shell}>
      <a class={styles.skip} href={`#${MAIN_ID}`}>
        {t('nav.skip')}
      </a>

      <SiteHeader pathname={pathnameOf(props.url)} signedIn={signedIn} operator={operator} />

      {/* `tabindex="-1"` is what makes the skip link move FOCUS and not just the viewport. */}
      <main id={MAIN_ID} class={styles.main} tabindex={-1}>
        <div class={`${styles.content} ${styles[width]}`}>{props.children}</div>
      </main>

      <SiteFooter signedIn={signedIn} />
    </div>
  );
}
