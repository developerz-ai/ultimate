// The control strip above a table or a list: filters and search at the inline start, actions at
// the inline end. `role="toolbar"` with the same roving-tabindex helper Tabs uses, so arrow keys
// move between the strip's buttons. It is NOT one tab stop: the strip holds arbitrary children it
// cannot reach into to set an initial `tabindex`, and a search field at the inline start keeps its
// own arrow keys, so making the strip a single stop would strand every control past it.

import type { JSX } from 'solid-js';
import { createRovingTabindex, focusableWithin } from '../a11y';
import { cx } from '../cx';
import { useUi } from '../theme/context';
import styles from './Toolbar.module.scss';

export interface ToolbarProps {
  /** Leading controls — search, filters, a Select. */
  children: JSX.Element;
  /** Trailing controls, pushed to the inline end. */
  actions?: JSX.Element | undefined;
  /** Already-translated accessible name. Required: an unnamed toolbar is an unnamed group. */
  label: string;
  /** Renders the strip on a raised, bordered surface. */
  surface?: boolean | undefined;
  class?: string | undefined;
}

export function Toolbar(props: ToolbarProps): JSX.Element {
  const ui = useUi();
  let strip: HTMLDivElement | undefined;

  // Arrows follow the writing direction; `focusableWithin` skips anything hidden or disabled, and
  // `createRovingTabindex` declines outright while a control that answers arrows itself — the
  // search Input this strip exists to hold — has focus.
  const onKeyDown = createRovingTabindex(
    () => (strip === undefined ? [] : focusableWithin(strip)),
    { orientation: 'horizontal', dir: ui.dir, loop: false },
  );

  return (
    <div
      ref={(el: HTMLDivElement) => {
        strip = el;
      }}
      class={cx(styles['toolbar'], props.surface === true && styles['surface'], props.class)}
      role="toolbar"
      aria-label={props.label}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
    >
      <div class={styles['start']}>{props.children}</div>
      {props.actions === undefined ? null : <div class={styles['end']}>{props.actions}</div>}
    </div>
  );
}
