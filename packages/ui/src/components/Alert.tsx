// Inline message bound to the page, not the viewport. `danger`/`warning` use
// `role="alert"` (assertive); the rest use `role="status"`, so an informational
// banner never interrupts what a screen-reader user is doing.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './Alert.module.scss';
import { type HeadingLevel, headingTag } from './heading-level';
import { headingNode } from './heading-node';
import { IconButton } from './IconButton';
import type { Tone } from './variants';

export interface AlertProps {
  /** Already-translated heading. */
  title?: string | undefined;
  children: JSX.Element;
  tone?: Tone | undefined;
  icon?: JSX.Element | undefined;
  /** Provide both to make the alert dismissible; the label is the a11y name. */
  onDismiss?: (() => void) | undefined;
  dismissLabel?: string | undefined;
  /** Titles the alert with a heading of this level; absent, a paragraph, as before. */
  level?: HeadingLevel | undefined;
  class?: string | undefined;
}

export function Alert(props: AlertProps): JSX.Element {
  const tone = (): Tone => props.tone ?? 'info';
  const assertive = (): boolean => tone() === 'danger' || tone() === 'warning';
  // Resolved once, so an off-scale level throws `X_UI_INVALID_VALUE` here, as PageHeader's does.
  const heading = props.level === undefined ? undefined : headingTag(props.level);
  const title = (): string => props.title ?? '';

  return (
    <div
      role={assertive() ? 'alert' : 'status'}
      aria-live={assertive() ? 'assertive' : 'polite'}
      class={cx(styles['alert'], styles[`tone-${tone()}`], props.class)}
    >
      {props.icon === undefined ? null : (
        <span aria-hidden="true" class={styles['icon']}>
          {props.icon}
        </span>
      )}
      <div class={styles['content']}>
        {props.title === undefined ? null : heading === undefined ? (
          <p class={styles['title']}>{title()}</p>
        ) : (
          headingNode(heading, { class: styles['title'] }, title)
        )}
        <div class={styles['body']}>{props.children}</div>
      </div>
      {props.onDismiss === undefined || props.dismissLabel === undefined ? null : (
        <IconButton label={props.dismissLabel} size="sm" onClick={() => props.onDismiss?.()}>
          <span aria-hidden="true">×</span>
        </IconButton>
      )}
    </div>
  );
}
