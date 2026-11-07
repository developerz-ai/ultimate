// The app's frame: brand mark, the sidebar with one link per destination, an environment pill,
// the page's own actions at the end of the bar, and a footer — composed over the catalog's
// `AppShell`, so the skip link, the landmarks and the phone layout are the framework's and not
// this file's. `site/page.tsx` does NOT use it: the landing page is a 0kb document and this is the
// signed-in product's chrome. Every page under `app/` does.
//
// `useT()`, not `t` from @ultimat3/i18n — see apps/web/site/page.tsx for why.
import { useT } from '@docs-site/i18n';
import { tryResolveEnvironment } from '@ultimat3/core';
import { AppShell, Icon, type IconGlyph, Link } from '@ultimat3/ui';
import { iconHexagon } from '@ultimat3/ui/icons/hexagon';
import { iconLayoutDashboard } from '@ultimat3/ui/icons/layout-dashboard';
import type { JSX } from 'solid-js';
import styles from './shell.module.scss';

/** The routes the sidebar knows about. A page names itself so its link can carry aria-current. */
export type ShellNav = 'dashboard';

export interface ShellProps {
  readonly nav?: ShellNav | undefined;
  /** Controls that belong to the page, rendered at the end of the header bar — a theme toggle. */
  readonly actions?: JSX.Element | undefined;
  readonly children: JSX.Element;
}

export function Shell(props: ShellProps): JSX.Element {
  const t = useT();
  // Where this build runs — a fact read from the process, never a translated word. Absent when
  // neither ULTIMATE_ENV nor NODE_ENV names one, and the pill is absent with it.
  const environment = tryResolveEnvironment();

  const item = (id: ShellNav, href: string, label: string, glyph: IconGlyph): JSX.Element => (
    <li>
      <Link
        class={styles.navLink}
        href={href}
        tone="inherit"
        underline="none"
        aria-current={props.nav === id ? 'page' : false}
      >
        <Icon glyph={glyph} size="sm" class={styles.navIcon} />
        <span>{label}</span>
      </Link>
    </li>
  );

  return (
    <div class={styles.doc}>
      <AppShell
        sidebarWidth="13.5rem"
        stickyHeader
        header={
          <div class={styles.bar}>
            <Link class={styles.brand} href="/" tone="inherit" underline="none">
              {/* The mark: one accent tile, one glyph. Decorative — the wordmark beside it is the name. */}
              <span class={styles.mark} aria-hidden="true">
                <Icon glyph={iconHexagon} size="sm" />
              </span>
              <span class={styles.wordmark}>{t('shell.brand')}</span>
            </Link>
            <div class={styles.end}>
              {environment === undefined ? null : (
                <span class={styles.env}>
                  {/* The pulse is a CSS opacity animation: alive without a byte of script. */}
                  <span class={styles.envDot} aria-hidden="true" />
                  <span class={styles.envLabel}>{environment}</span>
                </span>
              )}
              {props.actions}
            </div>
          </div>
        }
        sidebar={
          <ul class={styles.nav}>
            {item('dashboard', '/dashboard', t('shell.nav.dashboard'), iconLayoutDashboard)}
          </ul>
        }
        footer={<span>{t('shell.footer')}</span>}
      >
        {props.children}
      </AppShell>
    </div>
  );
}
