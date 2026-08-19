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

/**
 * `<select>` has NO `value` attribute — the selected option carries `selected`, and the parser
 * drops the attribute silently, so `value={…}` rendered every admin edit control on its first
 * option whatever the row held. The placeholder takes the selection when nothing matches, which
 * is also what keeps an unset field unsubmittable: that option is `disabled`.
 */
export function Select(props: SelectProps): JSX.Element {
  // Thunks, not setup-time reads: a prop read once at setup never tracks, so under a client Solid
  // runtime the selection would freeze at whatever the first render saw (ThemeToggle already feeds
  // this a signal). Every other value-formatting component in the package wraps its read the same way.
  const current = (): string => props.value ?? '';
  const matched = (): boolean => props.options.some((option) => option.value === current());
  return (
    <span class={cx(styles['wrap'], styles[`size-${props.size ?? 'md'}`], props.class)}>
      <select
        class={styles['select']}
        id={props.id}
        name={props.name}
        required={props.required === true}
        disabled={props.disabled === true}
        aria-label={props['aria-label']}
        aria-describedby={props['aria-describedby']}
        aria-invalid={ariaBool(props['aria-invalid'])}
        onChange={props.onChange}
      >
        {props.placeholder === undefined ? null : (
          <option value="" disabled selected={!matched()}>
            {props.placeholder}
          </option>
        )}
        {props.options.map((option) => (
          <option
            value={option.value}
            disabled={option.disabled === true}
            selected={option.value === current()}
          >
            {option.label}
          </option>
        ))}
      </select>
      <span aria-hidden="true" class={styles['chevron']} />
    </span>
  );
}
