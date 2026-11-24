// Inline message bound to the page, not the viewport. `danger`/`warning` use
// `role="alert"` (assertive); the rest use `role="status"`, so an informational
// banner never interrupts what a screen-reader user is doing.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './Alert.module.scss';
import type { HeadingLevel } from './heading-level';
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
        {/* A heading by role, as EmptyState's: an outline entry with no per-tag markup shipped. */}
        {props.title === undefined ? null : props.level === undefined ? (
          <p class={styles['title']}>{props.title}</p>
        ) : (
          // biome-ignore lint/a11y/useSemanticElements: as EmptyState's — the role, not six per-level templates in every island.
          <p class={styles['title']} role="heading" aria-level={props.level}>
            {props.title}
          </p>
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
