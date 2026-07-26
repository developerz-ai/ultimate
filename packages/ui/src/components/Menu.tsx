// Action menu: a trigger plus a `role="menu"` list with roving tabindex.
// Distinct from Select — a menu runs commands, it does not hold a form value.

import type { JSX } from 'solid-js';
import { createRovingTabindex, useId } from '../a11y';
import { cx } from '../cx';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import styles from './Menu.module.scss';

export interface MenuItem {
  id: string;
  /** Already-translated item label. */
  label: string;
  onSelect: () => void;
  disabled?: boolean | undefined;
  /** Renders with the danger role; use for irreversible actions. */
  destructive?: boolean | undefined;
  icon?: JSX.Element | undefined;
}

export interface MenuProps {
  items: readonly MenuItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: (control: {
    id: string;
    'aria-haspopup': 'menu';
    'aria-expanded': boolean;
    'aria-controls': string;
  }) => JSX.Element;
  /** Already-translated accessible name for the menu. */
  label: string;
  align?: 'start' | 'end' | undefined;
  class?: string | undefined;
}

export function Menu(props: MenuProps): JSX.Element {
  const ui = useUi();
  const rt = solid();
  const menuId = useId('menu');
  let root: HTMLDivElement | undefined;
  let list: HTMLDivElement | undefined;

  const onKeyDown = createRovingTabindex(
    () =>
      list === undefined ? [] : Array.from(list.querySelectorAll<HTMLElement>('[role="menuitem"]')),
    { orientation: 'vertical', dir: ui.dir },
  );

  rt.createEffect(() => {
    if (!props.open || typeof document === 'undefined') return;
    const onPointerDown = (event: Event): void => {
      if (root !== undefined && !root.contains(event.target as Node)) props.onOpenChange(false);
    };
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onOpenChange(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onEscape);
    rt.onCleanup(() => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onEscape);
    });
  });

  return (
    <div
      class={cx(styles['anchor'], props.class)}
      ref={(el: HTMLDivElement) => {
        root = el;
      }}
    >
      {props.trigger({
        id: `${menuId}-trigger`,
        'aria-haspopup': 'menu',
        'aria-expanded': props.open,
        'aria-controls': menuId,
      })}
      {props.open ? (
        <div
          ref={(el: HTMLDivElement) => {
            list = el;
          }}
          id={menuId}
          role="menu"
          aria-label={props.label}
          class={cx(styles['menu'], styles[`align-${props.align ?? 'start'}`])}
          onKeyDown={onKeyDown}
        >
          {props.items.map((item, index) => (
            <button
              type="button"
              role="menuitem"
              class={cx(styles['item'], item.destructive === true && styles['destructive'])}
              tabindex={index === 0 ? 0 : -1}
              disabled={item.disabled === true}
              onClick={() => {
                item.onSelect();
                props.onOpenChange(false);
              }}
            >
              {item.icon === undefined ? null : (
                <span aria-hidden="true" class={styles['icon']}>
                  {item.icon}
                </span>
              )}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
