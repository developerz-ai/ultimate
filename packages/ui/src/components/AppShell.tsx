// The page frame every app screen sits in: skip link, banner, navigation, main, contentinfo.
// Stateless on purpose — below `md` the sidebar becomes a band above the content instead of
// growing an open/closed flag, because an off-canvas menu is already `Drawer` and axiom 1 allows
// exactly one of those.

import type { JSX } from 'solid-js';
import { LIVE_REGION_LEVELS, liveRegionAttrs, useId } from '../a11y';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import styles from './AppShell.module.scss';
import { shellIds } from './app-shell-view';

export interface AppShellProps {
  /** The page. Rendered inside the one `<main>`, which is the skip link's target. */
  children: JSX.Element;
  header?: JSX.Element | undefined;
  /** Rendered inside a `<nav>` landmark at the inline start. */
  sidebar?: JSX.Element | undefined;
  footer?: JSX.Element | undefined;
  /** Accessible name for the sidebar landmark. Defaults to the translated `ui.navigation`. */
  sidebarLabel?: string | undefined;
  /** Skip-link text. Defaults to the translated `ui.skip`. */
  skipLabel?: string | undefined;
  /** Sidebar track width at `md` and up. Any CSS length. */
  sidebarWidth?: string | undefined;
  /** Keeps the header pinned while the main region scrolls. */
  stickyHeader?: boolean | undefined;
  class?: string | undefined;
}

export function AppShell(props: AppShellProps): JSX.Element {
  const ui = useUi();
  const ids = shellIds(useId('shell'));

  return (
    <div
      class={cx(styles['shell'], props.sidebar === undefined && styles['no-sidebar'], props.class)}
      style={{ '--shell-sidebar': props.sidebarWidth ?? '16rem' }}
    >
      <a class={styles['skip']} href={ids.skipHref}>
        {props.skipLabel ?? ui.t(UI_KEYS.skip)}
      </a>
      {props.header === undefined ? null : (
        <header class={cx(styles['header'], props.stickyHeader !== false && styles['sticky'])}>
          {props.header}
        </header>
      )}
      {props.sidebar === undefined ? null : (
        <nav class={styles['sidebar']} aria-label={props.sidebarLabel ?? ui.t(UI_KEYS.navigation)}>
          {props.sidebar}
        </nav>
      )}
      {/* tabindex="-1" is what makes the skip link move focus and not just the viewport. */}
      <main id={ids.mainId} class={styles['main']} tabindex={-1}>
        {props.children}
      </main>
      {props.footer === undefined ? null : <footer class={styles['footer']}>{props.footer}</footer>}
      {/* The two live regions, in the SERVER response and empty. `announce()` had none until
          2026-09 and built its own on first call — a region appended and written in the same frame,
          which most screen readers do not announce, so the first message of a session was silent.
          They are last in DOM order because they are never visible and never focusable: the class
          is `visually-hidden`, not `display: none`, which would stop them being read at all. */}
      {LIVE_REGION_LEVELS.map((politeness) => {
        const attrs = liveRegionAttrs(politeness);
        return (
          <div
            id={attrs.id}
            class={attrs.class}
            role={attrs.role}
            aria-live={attrs['aria-live']}
            aria-atomic={attrs['aria-atomic']}
          />
        );
      })}
    </div>
  );
}
