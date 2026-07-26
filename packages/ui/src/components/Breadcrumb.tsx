// Ancestor trail. The last item is the current page: rendered as text, never a
// link, and marked `aria-current="page"`. Separators are decorative CSS.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import styles from './Breadcrumb.module.scss';

export interface BreadcrumbItem {
  /** Already-translated label. */
  label: string;
  /** Omit on the final item — the current page is not a link. */
  href?: string | undefined;
}

export interface BreadcrumbProps {
  items: readonly BreadcrumbItem[];
  /** Overrides the translated `ui.breadcrumb` landmark name. */
  label?: string | undefined;
  class?: string | undefined;
}

export function Breadcrumb(props: BreadcrumbProps): JSX.Element {
  const ui = useUi();
  return (
    <nav
      class={cx(styles['breadcrumb'], props.class)}
      aria-label={props.label ?? ui.t(UI_KEYS.breadcrumb)}
    >
      <ol class={styles['list']}>
        {props.items.map((item, index) => (
          <li class={styles['item']}>
            {item.href === undefined || index === props.items.length - 1 ? (
              <span class={styles['current']} aria-current="page">
                {item.label}
              </span>
            ) : (
              <a class={styles['link']} href={item.href}>
                {item.label}
              </a>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
