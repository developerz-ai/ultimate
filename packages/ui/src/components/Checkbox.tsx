// Native checkbox with a token-drawn indicator. The label element wraps the
// input, so the whole row is a hit target without a manual `for`/`id` pairing.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './Checkbox.module.scss';

export interface CheckboxProps {
  /** Already-translated label. Required — an unlabelled checkbox is a bug. */
  label: string;
  id?: string | undefined;
  name?: string | undefined;
  value?: string | undefined;
  checked?: boolean | undefined;
  /** Tri-state for "some children selected". Mirrored to `aria-checked`. */
  indeterminate?: boolean | undefined;
  disabled?: boolean | undefined;
  required?: boolean | undefined;
  description?: string | undefined;
  class?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | undefined;
  onChange?: JSX.EventHandlerUnion<HTMLInputElement, Event> | undefined;
}

export function Checkbox(props: CheckboxProps): JSX.Element {
  return (
    <label class={cx(styles['row'], props.class)}>
      <input
        class={styles['input']}
        type="checkbox"
        id={props.id}
        name={props.name}
        value={props.value}
        checked={props.checked === true}
        disabled={props.disabled === true}
        required={props.required === true}
        aria-checked={props.indeterminate === true ? 'mixed' : props.checked === true}
        aria-describedby={props['aria-describedby']}
        aria-invalid={props['aria-invalid'] === true}
        onChange={props.onChange}
      />
      <span
        aria-hidden="true"
        class={styles['box']}
        data-mixed={props.indeterminate === true ? 'true' : undefined}
      />
      <span class={styles['text']}>
        <span class={styles['label']}>{props.label}</span>
        {props.description === undefined ? null : (
          <span class={styles['description']}>{props.description}</span>
        )}
      </span>
    </label>
  );
}
