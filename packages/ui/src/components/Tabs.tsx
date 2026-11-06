// Tablist with roving tabindex: one Tab in the page tab order, arrows move
// between them, Home/End jump to the ends, and arrow direction follows `dir`.
// Link mode (`hrefFor`, no `onChange`) is a `<nav>` of links with `aria-current`, never
// `role="tab"`: ARIA tabs promise panels on this page, and a link tab's panel is the next page.

import type { JSX } from 'solid-js';
import { ariaBool, rovingTabindex, useId } from '../a11y';
import { cx } from '../cx';
import { invalidValueError } from '../errors';
import { TAB_SELECTOR, tabStopIndex } from '../roving';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import { linkTarget } from './link-target';
import styles from './Tabs.module.scss';

export interface TabItem {
  id: string;
  /** Already-translated tab label. */
  label: string;
  panel: JSX.Element;
  disabled?: boolean | undefined;
}

export interface TabsButtonProps {
  items: readonly TabItem[];
  /** Selected tab id. Controlled — the caller owns the state. */
  value: string;
  onChange: (id: string) => void;
  /** Already-translated accessible name for the tablist. */
  label: string;
  orientation?: 'horizontal' | 'vertical' | undefined;
  hrefFor?: undefined;
  children?: undefined;
  class?: string | undefined;
}

/** A tab that is a URL: the page the link opens renders its own content. */
export interface TabLinkItem {
  id: string;
  /** Already-translated tab label. */
  label: string;
}

export interface TabsLinkProps {
  items: readonly TabLinkItem[];
  /** The current tab's id — the page being rendered. */
  value: string;
  /** Each tab's URL. Server-rendered links: no script, and the back button works. */
  hrefFor: (id: string) => string;
  /** The `<nav>`'s accessible name. */
  label: string;
  /** The current tab's content, rendered under the links. */
  children?: JSX.Element | undefined;
  onChange?: undefined;
  orientation?: undefined;
  class?: string | undefined;
}

export type TabsProps = TabsButtonProps | TabsLinkProps;

export function Tabs(props: TabsProps): JSX.Element {
  // A mode is fixed for a use, so the branch is decided once.
  if (props.hrefFor !== undefined) return LinkTabs(props);
  return ButtonTabs(props);
}

function LinkTabs(props: TabsLinkProps): JSX.Element {
  const rt = solid();
  let current: HTMLAnchorElement | undefined;
  // A strip wider than a phone scrolls in its own box; the current tab is brought into it.
  rt.createEffect(() => {
    if (current !== undefined && typeof current.scrollIntoView === 'function') {
      current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  });
  const href = (id: string): string | undefined => {
    const value: unknown = props.hrefFor(id);
    if (typeof value !== 'string') throw invalidValueError('Tabs hrefFor', value, 'a string URL');
    return linkTarget(value).href;
  };
  return (
    <div class={cx(styles['tabs'], styles['orientation-horizontal'], props.class)}>
      <nav aria-label={props.label}>
        <ul class={cx(styles['list'], styles['links'])}>
          {props.items.map((item) => (
            <li>
              <a
                ref={(el: HTMLAnchorElement) => {
                  if (item.id === props.value) current = el;
                }}
                class={styles['tab']}
                href={href(item.id)}
                aria-current={item.id === props.value ? 'page' : undefined}
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {props.children === undefined ? null : <div class={styles['panel']}>{props.children}</div>}
    </div>
  );
}

function ButtonTabs(props: TabsButtonProps): JSX.Element {
  const ui = useUi();
  const base = useId('tabs');
  let list: HTMLDivElement | undefined;

  // A disabled tab is excluded from BOTH answers — the list arrows walk and the one tab that
  // carries the tab stop — because `focus()` on a disabled button silently does nothing, so a
  // disabled tab left in the list pins the reducer on its index and hides every tab after it.
  const onKeyDown = rovingTabindex(
    () => (list === undefined ? [] : Array.from(list.querySelectorAll<HTMLElement>(TAB_SELECTOR))),
    { orientation: props.orientation ?? 'horizontal', dir: ui.dir },
  );
  // The selected tab holds the tab stop; a selected tab that is disabled, or a `value` matching no
  // tab at all, falls back to the first enabled one rather than leaving the tablist unreachable.
  const tabStop = (): number =>
    tabStopIndex(
      props.items,
      props.items.findIndex((item) => item.id === props.value),
    );

  return (
    <div
      class={cx(
        styles['tabs'],
        styles[`orientation-${props.orientation ?? 'horizontal'}`],
        props.class,
      )}
    >
      <div
        ref={(el: HTMLDivElement) => {
          list = el;
        }}
        class={styles['list']}
        role="tablist"
        aria-label={props.label}
        aria-orientation={props.orientation ?? 'horizontal'}
        onKeyDown={onKeyDown}
      >
        {props.items.map((item, index) => (
          <button
            type="button"
            role="tab"
            id={`${base}-tab-${item.id}`}
            class={styles['tab']}
            aria-selected={ariaBool(props.value === item.id)}
            aria-controls={`${base}-panel-${item.id}`}
            tabindex={index === tabStop() ? 0 : -1}
            disabled={item.disabled === true}
            onClick={() => props.onChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {props.items.map((item) => (
        <div
          role="tabpanel"
          id={`${base}-panel-${item.id}`}
          class={styles['panel']}
          aria-labelledby={`${base}-tab-${item.id}`}
          tabindex={0}
          hidden={props.value !== item.id}
        >
          {item.panel}
        </div>
      ))}
    </div>
  );
}
