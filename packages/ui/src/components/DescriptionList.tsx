// Terms and their details: `<dl>` with one `<div>` per group, so a pair stays together when the
// list stacks. A `Table` of two columns is the wrong landmark for facts about one thing.
// Server-only: no signal, no effect, 0 B of script on a static route.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './DescriptionList.module.scss';

export interface DescriptionItem {
  /** Already-translated term. */
  term: string;
  detail: JSX.Element;
}

export interface DescriptionListProps {
  items: readonly DescriptionItem[];
  /**
   * `columns` puts each term beside its detail and stacks them when the list's OWN width falls
   * below `sm` (a container query, never the viewport). `stacked` always stacks.
   */
  layout?: 'columns' | 'stacked' | undefined;
  class?: string | undefined;
}

export function DescriptionList(props: DescriptionListProps): JSX.Element {
  return (
    <div class={cx(styles['wrap'], props.class)}>
      <dl class={cx(styles['list'], styles[`layout-${props.layout ?? 'columns'}`])}>
        {props.items.map((item) => (
          <div class={styles['group']}>
            <dt class={styles['term']}>{item.term}</dt>
            <dd class={styles['detail']}>{item.detail}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
