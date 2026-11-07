// Edge-anchored panel, also a native <dialog> so it inherits the top layer and
// inert background. `side` is logical (`inline-start`/`inline-end`), so a drawer
// pinned to the start edge lands on the right in an RTL locale automatically.
//
// `side="block-end"` is the bottom sheet: with `grabber`, a drag from the grabber (only — the body
// keeps its scroll) moves it between `half` and `full` or closes it (`drawer-gesture-view.ts`).

import type { JSX } from 'solid-js';
import { useId } from '../a11y';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import styles from './Drawer.module.scss';
import { type DrawerSnap, dragOffset, releaseSnap } from './drawer-gesture-view';
import { IconButton } from './IconButton';

export type DrawerSide = 'inline-start' | 'inline-end' | 'block-start' | 'block-end';

export interface DrawerProps {
  open: boolean;
  /** Already-translated title. Becomes the drawer's accessible name. */
  title: string;
  children: JSX.Element;
  onClose: () => void;
  side?: DrawerSide | undefined;
  size?: string | undefined;
  footer?: JSX.Element | undefined;
  /**
   * `block-end` only: a handle to drag the sheet by. The drag has no keyboard form, so the close
   * button stays; Esc closes as ever.
   */
  grabber?: boolean | undefined;
  /** The height a `grabber` sheet opens at: `half` (the default) or `full` of the viewport. */
  snap?: DrawerSnap | undefined;
  class?: string | undefined;
}

export function Drawer(props: DrawerProps): JSX.Element {
  const ui = useUi();
  const rt = solid();
  const titleId = useId('drawer-title');
  let element: HTMLDialogElement | undefined;
  // Where the press STARTED — the `Dialog` rule: a drag-select begun in the panel and released
  // over the backdrop fires `click` on the <dialog> itself, and closed the drawer mid-selection.
  let pressedBackdrop = false;
  const sheet = (): boolean => props.grabber === true && props.side === 'block-end';
  const [snap, setSnap] = rt.createSignal<DrawerSnap>(props.snap ?? 'half');
  let drag: { readonly pointer: number; readonly y: number; readonly height: number } | undefined;

  const endDrag = (event: PointerEvent, release: boolean): void => {
    if (drag === undefined || event.pointerId !== drag.pointer || element === undefined) return;
    const delta = event.clientY - drag.y;
    const height = drag.height;
    drag = undefined;
    element.style.removeProperty('--drawer-drag');
    element.removeAttribute('data-dragging');
    if (!release) return;
    const next = releaseSnap(delta, height, snap());
    if (next === 'close') props.onClose();
    else setSnap(next);
  };

  rt.createEffect(() => {
    const dialog = element;
    if (dialog === undefined) return;
    if (props.open && !dialog.open) dialog.showModal();
    if (!props.open && dialog.open) dialog.close();
  });

  return (
    // The backdrop's keyboard equivalent is Esc, which <dialog> raises as `cancel`, and
    // `onCancel` below closes on it.
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes through onCancel
    <dialog
      ref={(el: HTMLDialogElement) => {
        element = el;
      }}
      class={cx(styles['drawer'], styles[`side-${props.side ?? 'inline-end'}`], props.class)}
      style={{ '--drawer-size': props.size ?? '22rem' }}
      data-snap={sheet() ? snap() : undefined}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
      onPointerDown={(event) => {
        pressedBackdrop = event.target === element;
      }}
      onClick={(event) => {
        const dismiss = pressedBackdrop && event.target === element;
        pressedBackdrop = false;
        if (dismiss) props.onClose();
      }}
    >
      <div class={styles['panel']}>
        {sheet() ? (
          // Pointer events here and nowhere else, `touch-action: none` on this box only: a drag
          // that began in the body would steal its scroll.
          <div
            class={styles['grabber']}
            aria-hidden="true"
            onPointerDown={(event) => {
              if (element === undefined) return;
              drag = {
                pointer: event.pointerId,
                y: event.clientY,
                height: element.getBoundingClientRect().height,
              };
              // A touch is captured by its target already; a mouse that leaves the grabber is not.
              if (event.pointerType === 'mouse') {
                event.currentTarget.setPointerCapture(event.pointerId);
              }
              element.setAttribute('data-dragging', '');
            }}
            onPointerMove={(event) => {
              if (drag === undefined || event.pointerId !== drag.pointer) return;
              const offset = dragOffset(event.clientY - drag.y, snap());
              element?.style.setProperty('--drawer-drag', `${offset}px`);
            }}
            onPointerUp={(event) => endDrag(event, true)}
            onPointerCancel={(event) => endDrag(event, false)}
          />
        ) : null}
        <header class={styles['header']}>
          <h2 class={styles['title']} id={titleId}>
            {props.title}
          </h2>
          <IconButton label={ui.t(UI_KEYS.close)} size="sm" onClick={() => props.onClose()}>
            <span aria-hidden="true">×</span>
          </IconButton>
        </header>
        <div class={styles['body']}>{props.children}</div>
        {props.footer === undefined ? null : (
          <footer class={styles['footer']}>{props.footer}</footer>
        )}
      </div>
    </dialog>
  );
}
