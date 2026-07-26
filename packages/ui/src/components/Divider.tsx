// A rule. Always an explicit `role="separator"` with an orientation; pass `label`
// to render a captioned separator, which is what a settings group actually needs.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './Divider.module.scss';

export interface DividerProps {
  orientation?: 'horizontal' | 'vertical' | undefined;
  /** Visible, already-translated caption rendered inside the rule. */
  label?: string | undefined;
  class?: string | undefined;
}

export function Divider(props: DividerProps): JSX.Element {
  const orientation = (): 'horizontal' | 'vertical' => props.orientation ?? 'horizontal';

  return props.label === undefined ? (
    <hr
      aria-orientation={orientation()}
      class={cx(styles['divider'], styles[orientation()], props.class)}
    />
  ) : (
    <div role="separator" class={cx(styles['labelled'], props.class)}>
      <span class={styles['label']}>{props.label}</span>
    </div>
  );
}
