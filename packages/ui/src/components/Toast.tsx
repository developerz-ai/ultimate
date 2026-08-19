// Transient notification. ToastRegion is the single live region for the app; individual Toasts
// are its children, so announcements are not duplicated and the region exists before the first
// message. That ordering is the whole point: a live region created with its content already in it
// is not announced by most screen readers, which is why `aria-live` sits on the persistent <ol>
// here and NOT on the <li> each Toast renders.

import type { JSX } from 'solid-js';
import type { Politeness } from '../a11y';
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
  /**
   * How the region announces. `polite` waits for a pause and is right for everything an app
   * routinely confirms; `assertive` interrupts whatever the user is being read, so it belongs only
   * to a region that carries errors alone. One region, one politeness — mixing tones inside one
   * list cannot work, because the live semantics belong to the list, not to the message.
   */
  politeness?: Politeness | undefined;
  placement?: 'block-end-inline-end' | 'block-start-inline-end' | 'block-end-center' | undefined;
  class?: string | undefined;
}

export function ToastRegion(props: ToastRegionProps): JSX.Element {
  // `aria-atomic="false"` on the list: only the toast that was just added is read, never the whole
  // list again on every arrival.
  return (
    <section
      class={cx(
        styles['region'],
        styles[`placement-${props.placement ?? 'block-end-inline-end'}`],
        props.class,
      )}
      aria-label={props.label}
    >
      <ol class={styles['list']} aria-live={props.politeness ?? 'polite'} aria-atomic="false">
        {props.children}
      </ol>
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

  // No `role` and no `aria-live`: the enclosing ToastRegion owns both. `role="status"` here would
  // also strip the element's `listitem` semantics, so the <ol> around it would announce a list of
  // nothing. A danger toast belongs in a ToastRegion declared `politeness="assertive"`.
  return (
    <li class={cx(styles['toast'], styles[`tone-${tone()}`], props.class)}>
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
