// The "nothing here yet" surface. Title and description arrive as already
// translated strings; the action slot takes a Button so there is one CTA shape.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import styles from './EmptyState.module.scss';
import { type HeadingLevel, headingTag } from './heading-level';
import { headingNode } from './heading-node';

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
  // Resolved once, so an off-scale level throws `X_UI_INVALID_VALUE` here, as PageHeader's does.
  const heading = props.level === undefined ? undefined : headingTag(props.level);
  const title = (): string => props.title ?? ui.t(UI_KEYS.empty);
  return (
    <div class={cx(styles['empty'], props.class)}>
      {props.icon === undefined ? null : (
        <span aria-hidden="true" class={styles['icon']}>
          {props.icon}
        </span>
      )}
      {heading === undefined ? (
        <p class={styles['title']}>{title()}</p>
      ) : (
        headingNode(heading, { class: styles['title'] }, title)
      )}
      {props.description === undefined ? null : (
        <p class={styles['description']}>{props.description}</p>
      )}
      {props.action === undefined ? null : <div class={styles['action']}>{props.action}</div>}
    </div>
  );
}
