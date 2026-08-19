// Tablist with roving tabindex: one Tab in the page tab order, arrows move
// between them, Home/End jump to the ends, and arrow direction follows `dir`.

import type { JSX } from 'solid-js';
import { ariaBool, createRovingTabindex, useId } from '../a11y';
import { cx } from '../cx';
import { TAB_SELECTOR, tabStopIndex } from '../roving';
import { useUi } from '../theme/context';
import styles from './Tabs.module.scss';

export interface TabItem {
  id: string;
  /** Already-translated tab label. */
  label: string;
  panel: JSX.Element;
  disabled?: boolean | undefined;
}

export interface TabsProps {
  items: readonly TabItem[];
  /** Selected tab id. Controlled — the caller owns the state. */
  value: string;
  onChange: (id: string) => void;
  /** Already-translated accessible name for the tablist. */
  label: string;
  orientation?: 'horizontal' | 'vertical' | undefined;
  class?: string | undefined;
}

export function Tabs(props: TabsProps): JSX.Element {
  const ui = useUi();
  const base = useId('tabs');
  let list: HTMLDivElement | undefined;

  // A disabled tab is excluded from BOTH answers — the list arrows walk and the one tab that
  // carries the tab stop — because `focus()` on a disabled button silently does nothing, so a
  // disabled tab left in the list pins the reducer on its index and hides every tab after it.
  const onKeyDown = createRovingTabindex(
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
