// The "nothing here yet" surface. Title and description arrive as already
// translated strings; the action slot takes a Button so there is one CTA shape.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import styles from './EmptyState.module.scss';

export interface EmptyStateProps {
  /** Already-translated. Falls back to the `ui.empty` catalog key. */
  title?: string | undefined;
  description?: string | undefined;
  icon?: JSX.Element | undefined;
  action?: JSX.Element | undefined;
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
      <p class={styles['title']}>{props.title ?? ui.t(UI_KEYS.empty)}</p>
      {props.description === undefined ? null : (
        <p class={styles['description']}>{props.description}</p>
      )}
      {props.action === undefined ? null : <div class={styles['action']}>{props.action}</div>}
    </div>
  );
}
