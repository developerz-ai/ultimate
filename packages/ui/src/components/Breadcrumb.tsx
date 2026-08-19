// Ancestor trail. The last item is the current page: rendered as text, never a
// link, and marked `aria-current="page"`. Separators are decorative CSS.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import styles from './Breadcrumb.module.scss';
import { linkTarget } from './link-target';

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
            {/* POSITION decides `aria-current`, never the presence of an href: an ancestor with no
                link is still an ancestor, and a second `aria-current="page"` in one nav announces
                the current page on a node that is not it. A trail carries exactly one. */}
            {index === props.items.length - 1 ? (
              <span class={styles['current']} aria-current="page">
                {item.label}
              </span>
            ) : item.href === undefined ? (
              <span class={styles['text']}>{item.label}</span>
            ) : (
              <a class={styles['link']} href={linkTarget(item.href).href}>
                {item.label}
              </a>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
