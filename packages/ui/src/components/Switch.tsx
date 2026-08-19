// Boolean toggle with immediate effect (as opposed to Checkbox, which is part of a form submit).
// `role="switch"` on a native checkbox keeps keyboard behaviour — and its checked state, which is
// why nothing here writes `aria-checked`: `role="switch"` maps the host `checked` state on its own,
// and an attribute mirroring it never updates on the no-JS path, where ARIA would then outrank the
// truth and announce the switch stuck in whichever position it was rendered in.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './Switch.module.scss';

export interface SwitchProps {
  /** Already-translated label. Required — the state alone is not a name. */
  label: string;
  checked?: boolean | undefined;
  id?: string | undefined;
  name?: string | undefined;
  disabled?: boolean | undefined;
  /** Put the label before the track, e.g. in a settings row. */
  labelPosition?: 'start' | 'end' | undefined;
  class?: string | undefined;
  'aria-describedby'?: string | undefined;
  onChange?: JSX.EventHandlerUnion<HTMLInputElement, Event> | undefined;
}

export function Switch(props: SwitchProps): JSX.Element {
  return (
    <label class={cx(styles['row'], styles[`label-${props.labelPosition ?? 'end'}`], props.class)}>
      <input
        class={styles['input']}
        type="checkbox"
        // The rule reads ARIA alone; this element's state comes from the HOST language. Applying
        // `role="switch"` to a native checkbox is the recommended technique precisely because the
        // browser maps the element's own checkedness onto it — and an `aria-checked` mirroring
        // `props.checked` is WORSE than absent: on the no-JS path nothing rewrites it after the
        // user toggles the box, and ARIA outranks host state in the accessibility tree.
        // biome-ignore lint/a11y/useAriaPropsForRole: native checkedness supplies the state
        role="switch"
        id={props.id}
        name={props.name}
        checked={props.checked === true}
        disabled={props.disabled === true}
        aria-describedby={props['aria-describedby']}
        onChange={props.onChange}
      />
      <span aria-hidden="true" class={styles['track']}>
        <span class={styles['knob']} />
      </span>
      <span class={styles['text']}>{props.label}</span>
    </label>
  );
}
