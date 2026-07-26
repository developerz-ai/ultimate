// Boolean toggle with immediate effect (as opposed to Checkbox, which is part of
// a form submit). `role="switch"` on a native checkbox keeps keyboard behaviour.

import type { JSX } from 'solid-js';
import { ariaBool } from '../a11y';
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
        role="switch"
        id={props.id}
        name={props.name}
        checked={props.checked === true}
        disabled={props.disabled === true}
        aria-checked={ariaBool(props.checked === true)}
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
