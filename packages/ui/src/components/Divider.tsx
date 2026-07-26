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
    // A captioned separator is the structural (non-focusable) flavour of the role, which
    // ARIA does not give a value and does not put in the tab order. `<hr>` is void, so the
    // caption has to live in a container that carries the role itself.
    // biome-ignore lint/a11y/useSemanticElements: <hr> cannot hold the caption
    // biome-ignore lint/a11y/useFocusableInteractive: a captioned rule is not a splitter
    <div
      // biome-ignore lint/a11y/useAriaPropsForRole: aria-valuenow is the splitter flavour's
      role="separator"
      aria-orientation={orientation()}
      class={cx(styles['labelled'], props.class)}
    >
      <span class={styles['label']}>{props.label}</span>
    </div>
  );
}
