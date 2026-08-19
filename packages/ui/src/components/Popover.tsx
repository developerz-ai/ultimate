// Non-modal anchored panel. Positioning is CSS-only (a relatively positioned
// anchor plus logical insets), so there is no measure/reflow loop and the panel
// flips sides automatically under `dir="rtl"`.

import type { JSX } from 'solid-js';
import { createFocusTrap, useId } from '../a11y';
import { cx } from '../cx';
import { solid } from '../theme/solid-adapter';
import styles from './Popover.module.scss';

export type Placement = 'block-end' | 'block-start' | 'inline-end' | 'inline-start';

export interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The anchor. Wire its onClick to `onOpenChange` in the caller. */
  trigger: (control: {
    id: string;
    'aria-expanded': boolean;
    'aria-controls': string;
  }) => JSX.Element;
  children: JSX.Element;
  /** Already-translated accessible name for the panel. */
  label: string;
  placement?: Placement | undefined;
  align?: 'start' | 'center' | 'end' | undefined;
  class?: string | undefined;
}

export function Popover(props: PopoverProps): JSX.Element {
  const rt = solid();
  const panelId = useId('popover');
  const triggerId = `${panelId}-trigger`;
  let root: HTMLDivElement | undefined;
  let panel: HTMLDivElement | undefined;

  rt.createEffect(() => {
    if (!props.open || typeof document === 'undefined') return;
    const onPointerDown = (event: Event): void => {
      if (root !== undefined && !root.contains(event.target as Node)) props.onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onOpenChange(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    // Closing unmounts the panel with focus inside it, which drops focus to <body> and makes the
    // next Tab restart at the top of the document. The trap moves focus into the panel on open and
    // hands it back to the trigger on close.
    const trap = panel === undefined ? undefined : createFocusTrap(panel);
    trap?.activate();
    rt.onCleanup(() => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      trap?.release();
    });
  });

  return (
    <div
      class={cx(styles['anchor'], props.class)}
      ref={(el: HTMLDivElement) => {
        root = el;
      }}
    >
      {props.trigger({ id: triggerId, 'aria-expanded': props.open, 'aria-controls': panelId })}
      {props.open ? (
        <div
          ref={(el: HTMLDivElement) => {
            panel = el;
          }}
          id={panelId}
          role="dialog"
          aria-label={props.label}
          class={cx(
            styles['panel'],
            styles[`placement-${props.placement ?? 'block-end'}`],
            styles[`align-${props.align ?? 'start'}`],
          )}
        >
          {props.children}
        </div>
      ) : null}
    </div>
  );
}
