// One labelled text input, and the only place this app decides what a form control looks like.
//
// `@ultimat3/ui`'s `Field` cannot be used here: it calls `useUi()`, which needs a registered Solid
// runtime that a server render through the inert JSX factory does not have. Two auth pages had
// hand-rolled the same label/input/hint block twice, and they had already drifted.

import type { JSX } from 'solid-js';
import styles from './field.module.scss';

export interface FieldProps {
  readonly id: string;
  readonly name: string;
  /** Already-translated. */
  readonly label: string;
  readonly type?: string | undefined;
  readonly autocomplete?: string | undefined;
  readonly required?: boolean | undefined;
  readonly maxlength?: number | undefined;
  readonly minlength?: number | undefined;
  readonly pattern?: string | undefined;
  /** Already-translated. Wired to the input with `aria-describedby`, never left floating beside it. */
  readonly hint?: string | undefined;
}

export function Field(props: FieldProps): JSX.Element {
  const hintId = `${props.id}-hint`;

  return (
    <div class={styles.field}>
      <label class={styles.label} for={props.id}>
        {props.label}
      </label>
      <input
        class={styles.input}
        id={props.id}
        name={props.name}
        type={props.type ?? 'text'}
        autocomplete={props.autocomplete}
        required={props.required}
        maxlength={props.maxlength}
        minlength={props.minlength}
        pattern={props.pattern}
        aria-describedby={props.hint === undefined ? undefined : hintId}
      />
      {props.hint === undefined ? null : (
        <p class={styles.hint} id={hintId}>
          {props.hint}
        </p>
      )}
    </div>
  );
}
