// The "nothing here yet" surface. Title and description arrive as already
// translated strings; the action slot takes a Button so there is one CTA shape.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import styles from './EmptyState.module.scss';
import type { HeadingLevel } from './heading-level';

export interface EmptyStateProps {
  /** Already-translated. Falls back to the `ui.empty` catalog key. */
  title?: string | undefined;
  description?: string | undefined;
  icon?: JSX.Element | undefined;
  action?: JSX.Element | undefined;
  /**
   * Titles the state with a heading of this level, so a screen reader's heading list reaches it.
   * Absent: a paragraph, as before — the state is not part of the page outline.
   */
  level?: HeadingLevel | undefined;
  class?: string | undefined;
}

export function EmptyState(props: EmptyStateProps): JSX.Element {
  const ui = useUi();

  return (
    <div class={cx(styles['empty'], props.class)}>
      {props.icon === undefined ? null : (
        <span aria-hidden="true" class={styles['icon']}>
          {props.icon}
        </span>
      )}
      {/* A heading by role, not by tag: the same outline entry for a screen reader, and no
          per-tag markup shipped in every island that renders an empty state. */}
      {props.level === undefined ? (
        <p class={styles['title']}>{props.title ?? ui.t(UI_KEYS.empty)}</p>
      ) : (
        // biome-ignore lint/a11y/useSemanticElements: an <h1>-<h6> per level is six templates in every island that renders this; the role is the same outline entry.
        <p class={styles['title']} role="heading" aria-level={props.level}>
          {props.title ?? ui.t(UI_KEYS.empty)}
        </p>
      )}
      {props.description === undefined ? null : (
        <p class={styles['description']}>{props.description}</p>
      )}
      {props.action === undefined ? null : <div class={styles['action']}>{props.action}</div>}
    </div>
  );
}
