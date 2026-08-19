// Modal built on native <dialog>: the platform gives us the top layer, the backdrop, inert
// background content, and Escape-to-close for free. We add the labelled heading and the close
// affordance. Body scroll locking is one CSS rule in `tokens/reset.scss` (`html:has(dialog:modal)`)
// rather than anything here, so it covers Drawer too and cannot leak when a close path throws.

import type { JSX } from 'solid-js';
import { useId } from '../a11y';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import styles from './Dialog.module.scss';
import { IconButton } from './IconButton';

export interface DialogProps {
  open: boolean;
  /** Already-translated title. Becomes the dialog's accessible name. */
  title: string;
  children: JSX.Element;
  footer?: JSX.Element | undefined;
  onClose: () => void;
  size?: 'sm' | 'md' | 'lg' | 'full' | undefined;
  /** Clicking the backdrop closes. Turn off for destructive confirmations. */
  dismissOnBackdrop?: boolean | undefined;
  class?: string | undefined;
}

export function Dialog(props: DialogProps): JSX.Element {
  const ui = useUi();
  const rt = solid();
  const titleId = useId('dialog-title');
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
      class={cx(styles['dialog'], styles[`size-${props.size ?? 'md'}`], props.class)}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the <dialog> itself, never a child.
        if (props.dismissOnBackdrop !== false && event.target === element) props.onClose();
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
