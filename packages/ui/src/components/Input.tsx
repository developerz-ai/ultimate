// Single-line text control. No `type="number"` convenience wrapper: numeric
// input uses `inputmode` + a text type so locale decimal separators survive.

import type { JSX } from 'solid-js';
import { ariaBool } from '../a11y';
import { cx } from '../cx';
import styles from './Input.module.scss';
import type { Size } from './variants';

export type InputType =
  | 'text'
  | 'email'
  | 'password'
  | 'search'
  | 'tel'
  | 'url'
  | 'date'
  | 'time'
  | 'datetime-local';

export interface InputProps {
  id?: string | undefined;
  name?: string | undefined;
  type?: InputType | undefined;
  value?: string | undefined;
  placeholder?: string | undefined;
  size?: Size | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  readonly?: boolean | undefined;
  autocomplete?: string | undefined;
  inputmode?: 'text' | 'numeric' | 'decimal' | 'tel' | 'email' | 'url' | 'search' | undefined;
  maxlength?: number | undefined;
  /** Non-interactive adornments; keep them icons or units, never controls. */
  prefix?: JSX.Element | undefined;
  suffix?: JSX.Element | undefined;
  class?: string | undefined;
  'aria-label'?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | undefined;
  onInput?: JSX.EventHandlerUnion<HTMLInputElement, InputEvent> | undefined;
  onChange?: JSX.EventHandlerUnion<HTMLInputElement, Event> | undefined;
  onBlur?: JSX.EventHandlerUnion<HTMLInputElement, FocusEvent> | undefined;
}

export function Input(props: InputProps): JSX.Element {
  return (
    <span
      class={cx(styles['wrap'], styles[`size-${props.size ?? 'md'}`], props.class)}
      data-disabled={props.disabled === true ? 'true' : undefined}
    >
      {props.prefix === undefined ? null : (
        <span aria-hidden="true" class={styles['adornment']}>
          {props.prefix}
        </span>
      )}
      <input
        class={styles['input']}
        id={props.id}
        name={props.name}
        type={props.type ?? 'text'}
        value={props.value ?? ''}
        placeholder={props.placeholder}
        required={props.required === true}
        disabled={props.disabled === true}
        readonly={props.readonly === true}
        autocomplete={props.autocomplete}
        inputmode={props.inputmode}
        maxlength={props.maxlength}
        aria-label={props['aria-label']}
        aria-describedby={props['aria-describedby']}
        aria-invalid={ariaBool(props['aria-invalid'])}
        onInput={props.onInput}
        onChange={props.onChange}
        onBlur={props.onBlur}
      />
      {props.suffix === undefined ? null : (
        <span aria-hidden="true" class={styles['adornment']}>
          {props.suffix}
        </span>
      )}
    </span>
  );
}
