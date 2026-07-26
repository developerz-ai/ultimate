// Tablist with roving tabindex: one Tab in the page tab order, arrows move
// between them, Home/End jump to the ends, and arrow direction follows `dir`.

import type { JSX } from 'solid-js';
import { createRovingTabindex, useId } from '../a11y';
import { cx } from '../cx';
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

  const onKeyDown = createRovingTabindex(
    () =>
      list === undefined ? [] : Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]')),
    { orientation: props.orientation ?? 'horizontal', dir: ui.dir },
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
        {props.items.map((item) => (
          <button
            type="button"
            role="tab"
            id={`${base}-tab-${item.id}`}
            class={styles['tab']}
            aria-selected={props.value === item.id}
            aria-controls={`${base}-panel-${item.id}`}
            tabindex={props.value === item.id ? 0 : -1}
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
