// Indeterminate progress. `role="status"` plus a translated name, because a
// spinner with no accessible name is silence to a screen reader.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import styles from './Spinner.module.scss';
import type { Size } from './variants';

export interface SpinnerProps {
  size?: Size | undefined;
  /** Overrides the translated `ui.loading` default. */
  label?: string | undefined;
  /** Hide from assistive tech when a parent already announces the busy state. */
  decorative?: boolean | undefined;
  class?: string | undefined;
}

export function Spinner(props: SpinnerProps): JSX.Element {
  const ui = useUi();
  const className = (): string =>
    cx(styles['spinner'], styles[`size-${props.size ?? 'md'}`], props.class);

  return props.decorative === true ? (
    <span aria-hidden="true" class={className()} />
  ) : (
    <span
      role="status"
      aria-live="polite"
      aria-label={props.label ?? ui.t(UI_KEYS.loading)}
      class={className()}
    />
  );
}
