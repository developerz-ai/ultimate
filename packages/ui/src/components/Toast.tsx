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
import type { ToastHold } from '../toast/toast-state';
import { IconButton } from './IconButton';
import styles from './Toast.module.scss';
import type { Tone } from './variants';

/** Where the stack sits. Logical corners, so it follows the writing direction. */
export type ToastPlacement = 'block-end-inline-end' | 'block-start-inline-end' | 'block-end-center';

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
  placement?: ToastPlacement | undefined;
  /**
   * Stop the dwell while the reader is engaged with the stack, and start it again when they leave.
   * WCAG 2.2 2.2.1 wants a timing the user can extend, and a message that expires under the
   * pointer reaching for its undo is the failure that rule is about.
   *
   * Two reasons, reported separately: a pointer leaving a toast a keyboard user is still inside
   * must not restart the countdown, which one boolean cannot express.
   */
  onHold?: ((reason: ToastHold) => void) | undefined;
  onRelease?: ((reason: ToastHold) => void) | undefined;
  class?: string | undefined;
}

export function ToastRegion(props: ToastRegionProps): JSX.Element {
  // `aria-atomic="false"` on the list: only the toast that was just added is read, never the whole
  // list again on every arrival.
  //
  // The four handlers sit on the <ol> and all four BUBBLE. `mouseenter`/`mouseleave` do not, and
  // this list is `pointer-events: none` so it is not a hit target of its own — only the toasts
  // inside it are. `mouseover`/`mouseout` reach here from them; `mouseenter` would fire on a box
  // the pointer can never be over.
  return (
    <section
      class={cx(
        styles['region'],
        styles[`placement-${props.placement ?? 'block-end-inline-end'}`],
        props.class,
      )}
      aria-label={props.label}
    >
      {/* biome-ignore lint/a11y/useKeyWithMouseEvents: the rule wants `onFocus` beside
          `onMouseOver`, and `onFocus` is the WRONG half of the pair here — `focus` does not
          bubble, so a handler on this list would never hear a toast's dismiss button being
          reached, which is the exact case the pause exists for. `onFocusIn`/`onFocusOut` are the
          bubbling forms and are both present, so the keyboard path this rule protects is covered. */}
      <ol
        class={styles['list']}
        aria-live={props.politeness ?? 'polite'}
        aria-atomic="false"
        onMouseOver={() => props.onHold?.('pointer')}
        onMouseOut={() => props.onRelease?.('pointer')}
        onFocusIn={() => props.onHold?.('focus')}
        onFocusOut={() => props.onRelease?.('focus')}
      >
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
