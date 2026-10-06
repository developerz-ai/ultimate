// The page frame every app screen sits in: skip link, banner, navigation, main, contentinfo.
// Stateless, and scriptless: below `md` the sidebar `<nav>` is a native `popover` panel at the
// inline-start edge, opened by a `popovertarget` menu button — the browser holds the open state,
// Esc and light dismiss, so the frame on every page costs no island. Not `Drawer`: that is a modal
// `<dialog>` opened from an effect, so it needs a hydrated island, and a `<dialog>` cannot also be
// the in-flow `navigation` landmark at `md` and up. An engine with no popovers keeps the old band.

import type { JSX } from 'solid-js';
import { LIVE_REGION_LEVELS, liveRegionAttrs, useId } from '../a11y';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { iconMenu } from '../icons/glyphs/menu';
import { iconX } from '../icons/glyphs/x';
import { useUi } from '../theme/context';
import styles from './AppShell.module.scss';
import { shellIds } from './app-shell-view';
import { Icon } from './Icon';

export interface AppShellProps {
  /** The page. Rendered inside the one `<main>`, which is the skip link's target. */
  children: JSX.Element;
  header?: JSX.Element | undefined;
  /** Rendered inside a `<nav>` landmark: the inline-start column at `md` and up, a panel below. */
  sidebar?: JSX.Element | undefined;
  footer?: JSX.Element | undefined;
  /** Accessible name for the sidebar landmark. Defaults to the translated `ui.navigation`. */
  sidebarLabel?: string | undefined;
  /** Skip-link text. Defaults to the translated `ui.skip`. */
  skipLabel?: string | undefined;
  /** The menu button's text below `md`. Defaults to the translated `ui.menu`. */
  menuLabel?: string | undefined;
  /** Sidebar track width at `md` and up, and the panel's width below. Any CSS length. */
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
      {props.header === undefined && props.sidebar === undefined ? null : (
        // The menu button sits beside the banner, not inside it: the header holds exactly what
        // the app handed it, and the bar is what sticks.
        <div
          class={cx(
            styles['top'],
            // A bar holding only the menu button is shown only where that button is.
            props.header === undefined && styles['menuOnly'],
            props.stickyHeader !== false && styles['sticky'],
          )}
        >
          {props.sidebar === undefined ? null : (
            <button type="button" class={styles['menuButton']} popovertarget={ids.navId}>
              <Icon glyph={iconMenu} size="md" />
              <span class={styles['menuLabel']}>{props.menuLabel ?? ui.t(UI_KEYS.menu)}</span>
            </button>
          )}
          {props.header === undefined ? null : (
            <header class={styles['header']}>{props.header}</header>
          )}
        </div>
      )}
      {props.sidebar === undefined ? null : (
        <nav
          id={ids.navId}
          class={styles['sidebar']}
          popover="auto"
          aria-label={props.sidebarLabel ?? ui.t(UI_KEYS.navigation)}
        >
          <button
            type="button"
            class={styles['close']}
            popovertarget={ids.navId}
            popovertargetaction="hide"
            aria-label={ui.t(UI_KEYS.close)}
          >
            <Icon glyph={iconX} size="md" />
          </button>
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
