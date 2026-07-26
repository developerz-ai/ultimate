// Transient notification. ToastRegion is the single live region for the app;
// individual Toasts are its children, so announcements are not duplicated and
// the region exists before the first message (screen readers require that).

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { IconButton } from './IconButton';
import styles from './Toast.module.scss';
import type { Tone } from './variants';

export interface ToastRegionProps {
  children: JSX.Element;
  /** Already-translated landmark name, e.g. "Notifications". */
  label: string;
  placement?: 'block-end-inline-end' | 'block-start-inline-end' | 'block-end-center' | undefined;
  class?: string | undefined;
}

export function ToastRegion(props: ToastRegionProps): JSX.Element {
  return (
    <section
      class={cx(
        styles['region'],
        styles[`placement-${props.placement ?? 'block-end-inline-end'}`],
        props.class,
      )}
      aria-label={props.label}
    >
      <ol class={styles['list']}>{props.children}</ol>
    </section>
  );
}

export interface ToastProps {
  /** Already-translated message. */
  children: JSX.Element;
  title?: string | undefined;
  tone?: Tone | undefined;
  action?: JSX.Element | undefined;
  onDismiss?: (() => void) | undefined;
  dismissLabel?: string | undefined;
  class?: string | undefined;
}

export function Toast(props: ToastProps): JSX.Element {
  const ui = useUi();
  const tone = (): Tone => props.tone ?? 'neutral';
  const assertive = (): boolean => tone() === 'danger';

  return (
    <li
      class={cx(styles['toast'], styles[`tone-${tone()}`], props.class)}
      role={assertive() ? 'alert' : 'status'}
      aria-live={assertive() ? 'assertive' : 'polite'}
    >
      <div class={styles['content']}>
        {props.title === undefined ? null : <p class={styles['title']}>{props.title}</p>}
        <div class={styles['body']}>{props.children}</div>
      </div>
      {props.action}
      {props.onDismiss === undefined ? null : (
        <IconButton
          label={props.dismissLabel ?? ui.t(UI_KEYS.dismiss)}
          size="sm"
          onClick={() => props.onDismiss?.()}
        >
          <span aria-hidden="true">×</span>
        </IconButton>
      )}
    </li>
  );
}
