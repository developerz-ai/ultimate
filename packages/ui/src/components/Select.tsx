// Native <select>. Deliberately not a custom listbox: the platform control wins
// on mobile, on keyboard, and with screen readers.

import type { JSX } from 'solid-js';
import { ariaBool } from '../a11y';
import { cx } from '../cx';
import styles from './Select.module.scss';
import type { Size } from './variants';

export interface SelectOption {
  value: string;
  /** Already-translated option text. */
  label: string;
  disabled?: boolean | undefined;
}

export interface SelectProps {
  options: readonly SelectOption[];
  id?: string | undefined;
  name?: string | undefined;
  value?: string | undefined;
  /** Rendered as a disabled first option, so it is never a submittable value. */
  placeholder?: string | undefined;
  size?: Size | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  class?: string | undefined;
  'aria-label'?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | undefined;
  onChange?: JSX.EventHandlerUnion<HTMLSelectElement, Event> | undefined;
}

export function Select(props: SelectProps): JSX.Element {
  return (
    <span class={cx(styles['wrap'], styles[`size-${props.size ?? 'md'}`], props.class)}>
      <select
        class={styles['select']}
        id={props.id}
        name={props.name}
        value={props.value ?? ''}
        required={props.required === true}
        disabled={props.disabled === true}
        aria-label={props['aria-label']}
        aria-describedby={props['aria-describedby']}
        aria-invalid={ariaBool(props['aria-invalid'])}
        onChange={props.onChange}
      >
        {props.placeholder === undefined ? null : (
          <option value="" disabled>
            {props.placeholder}
          </option>
        )}
        {props.options.map((option) => (
          <option value={option.value} disabled={option.disabled === true}>
            {option.label}
          </option>
        ))}
      </select>
      <span aria-hidden="true" class={styles['chevron']} />
    </span>
  );
}
