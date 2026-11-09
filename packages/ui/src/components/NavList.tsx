// The ways around an app: links only (a command is `Menu`'s), in groups, one marked current by
// `currentOf` — the longest href covering the page. Server-rendered and scriptless; a collapsible
// group is a `<details>`, open when it holds the current page.
//
// Renders lists, not a `<nav>`: it sits in `AppShell`'s sidebar, which is already the navigation
// landmark, and a second one inside it would announce the same region twice.

import type { JSX } from 'solid-js';
import { useId } from '../a11y';
import { cx } from '../cx';
import { linkTarget } from './link-target';
import styles from './NavList.module.scss';
import { currentOf } from './nav-list-view';

export interface NavListLink {
  /** Already translated. */
  label: string;
  href: string;
  /** An `<Icon>`, decorative: the label is the name. */
  icon?: JSX.Element | undefined;
  /** A count or state beside the label — a `<Badge>`. */
  badge?: JSX.Element | undefined;
}

export interface NavListGroup {
  /** Already-translated group heading. */
  label: string;
  items: readonly NavListLink[];
  /** A `<details>` the reader can fold; always open while it holds the current page. */
  collapsible?: boolean | undefined;
}

export type NavListEntry = NavListLink | NavListGroup;

export interface NavListProps {
  items: readonly NavListEntry[];
  /** The page's own path — `currentOf` decides which one link carries `aria-current="page"`. */
  currentHref: string;
  class?: string | undefined;
}

const isGroup = (entry: NavListEntry): entry is NavListGroup => 'items' in entry;

export function NavList(props: NavListProps): JSX.Element {
  const base = useId('nav-group');
  const links = props.items.flatMap((entry) => (isGroup(entry) ? entry.items : [entry]));
  const current = links[currentOf(links, props.currentHref)];

  const link = (item: NavListLink): JSX.Element => (
    <li>
      <a
        class={styles['link']}
        href={linkTarget(item.href).href}
        aria-current={item === current ? 'page' : undefined}
      >
        {item.icon === undefined ? null : <span class={styles['icon']}>{item.icon}</span>}
        <span class={styles['label']}>{item.label}</span>
        {item.badge === undefined ? null : <span class={styles['badge']}>{item.badge}</span>}
      </a>
    </li>
  );

  return (
    <ul class={cx(styles['list'], props.class)}>
      {props.items.map((entry, index) => {
        if (!isGroup(entry)) return link(entry);
        const headingId = `${base}-${index}`;
        const list = (
          <ul class={styles['list']} aria-labelledby={headingId}>
            {entry.items.map(link)}
          </ul>
        );
        return (
          <li class={styles['group']}>
            {entry.collapsible === true ? (
              <details
                open={current !== undefined && entry.items.includes(current) ? true : undefined}
              >
                <summary class={styles['heading']} id={headingId}>
                  {entry.label}
                </summary>
                {list}
              </details>
            ) : (
              <p class={styles['heading']} id={headingId}>
                {entry.label}
              </p>
            )}
            {entry.collapsible === true ? null : list}
          </li>
        );
      })}
    </ul>
  );
}
