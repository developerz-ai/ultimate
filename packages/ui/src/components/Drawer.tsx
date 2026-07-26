// Edge-anchored panel, also a native <dialog> so it inherits the top layer and
// inert background. `side` is logical (`inline-start`/`inline-end`), so a drawer
// pinned to the start edge lands on the right in an RTL locale automatically.

import type { JSX } from 'solid-js';
import { useId } from '../a11y';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import styles from './Drawer.module.scss';
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
  class?: string | undefined;
}

export function Drawer(props: DrawerProps): JSX.Element {
  const ui = useUi();
  const rt = solid();
  const titleId = useId('drawer-title');
  let element: HTMLDialogElement | undefined;

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
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
      onClick={(event) => {
        if (event.target === element) props.onClose();
      }}
    >
      <div class={styles['panel']}>
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
