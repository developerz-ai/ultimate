// The phone's destination bar: up to five links along the bottom edge, in thumb reach, the current
// one marked by `currentOf` — the same rule as `NavList`. No state and no script: links with
// `aria-current`, server-rendered. Its padding clears the home indicator (`safe-area-padding`);
// `AppShell bottomNav` shows it below `md` and reserves the space so no content hides under it.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import styles from './BottomNav.module.scss';
import { bottomNavItems } from './bottom-nav-view';
import { linkTarget } from './link-target';
import { currentOf } from './nav-list-view';

export interface BottomNavItem {
  /** Already translated; shown under the icon, never only as a tooltip. */
  label: string;
  href: string;
  /** An `<Icon>`, decorative. */
  icon: JSX.Element;
}

export interface BottomNavProps {
  /** At most five; a sixth is `X_UI_INVALID_VALUE`. */
  items: readonly BottomNavItem[];
  currentHref: string;
  /** The landmark's name. Defaults to the translated `ui.navigation`. */
  label?: string | undefined;
  class?: string | undefined;
}

export function BottomNav(props: BottomNavProps): JSX.Element {
  const ui = useUi();
  const items = bottomNavItems(props.items);
  const current = currentOf(items, props.currentHref);
  return (
    <nav
      class={cx(styles['bar'], props.class)}
      aria-label={props.label ?? ui.t(UI_KEYS.navigation)}
    >
      <ul class={styles['list']}>
        {items.map((item, index) => (
          <li class={styles['item']}>
            <a
              class={styles['link']}
              href={linkTarget(item.href).href}
              aria-current={index === current ? 'page' : undefined}
            >
              <span class={styles['icon']}>{item.icon}</span>
              <span class={styles['label']}>{item.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
