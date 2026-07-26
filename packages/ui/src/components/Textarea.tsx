// Multi-line text control. `field-sizing: content` grows the box natively where
// supported, with `rows` as the floor — no resize observer, no JS.

import type { JSX } from 'solid-js';
import { ariaBool } from '../a11y';
import { cx } from '../cx';
import styles from './Textarea.module.scss';

export interface TextareaProps {
  id?: string | undefined;
  name?: string | undefined;
  value?: string | undefined;
  placeholder?: string | undefined;
  rows?: number | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  readonly?: boolean | undefined;
  maxlength?: number | undefined;
  autoGrow?: boolean | undefined;
  class?: string | undefined;
  'aria-label'?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | undefined;
  onInput?: JSX.EventHandlerUnion<HTMLTextAreaElement, InputEvent> | undefined;
  onBlur?: JSX.EventHandlerUnion<HTMLTextAreaElement, FocusEvent> | undefined;
}

export function Textarea(props: TextareaProps): JSX.Element {
  return (
    <textarea
      class={cx(styles['textarea'], props.autoGrow === true && styles['autoGrow'], props.class)}
      id={props.id}
      name={props.name}
      value={props.value ?? ''}
      placeholder={props.placeholder}
      rows={props.rows ?? 3}
      required={props.required === true}
      disabled={props.disabled === true}
      readonly={props.readonly === true}
      maxlength={props.maxlength}
      aria-label={props['aria-label']}
      aria-describedby={props['aria-describedby']}
      aria-invalid={ariaBool(props['aria-invalid'])}
      onInput={props.onInput}
      onBlur={props.onBlur}
    />
  );
}
