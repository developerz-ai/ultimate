// Label + hint + error, wired for a11y. Field owns the ids and hands them to the
// control through a render prop, so `aria-describedby` and `aria-invalid` can
// never drift out of sync with what is actually rendered.

import type { JSX } from 'solid-js';
import { useId } from '../a11y';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import styles from './Field.module.scss';

/** Spread straight onto Input/Textarea/Select/Checkbox. */
export interface FieldControl {
  readonly id: string;
  readonly 'aria-describedby': string | undefined;
  readonly 'aria-invalid': boolean;
  readonly required: boolean;
}

export interface FieldProps {
  /** Already-translated label. Rendered as a real <label for>. */
  label: string;
  children: (control: FieldControl) => JSX.Element;
  hint?: string | undefined;
  /** Present means invalid; the string is announced with the control. */
  error?: string | undefined;
  required?: boolean | undefined;
  /** Appends a translated "(optional)" marker instead of marking required. */
  markOptional?: boolean | undefined;
  class?: string | undefined;
}

export function Field(props: FieldProps): JSX.Element {
  const ui = useUi();
  const id = useId('field');
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const describedBy = (): string | undefined => {
    const ids = [
      props.hint === undefined ? null : hintId,
      props.error === undefined ? null : errorId,
    ].filter((value): value is string => value !== null);
    return ids.length === 0 ? undefined : ids.join(' ');
  };

  const control = (): FieldControl => ({
    id,
    'aria-describedby': describedBy(),
    'aria-invalid': props.error !== undefined,
    required: props.required === true,
  });

  return (
    <div class={cx(styles['field'], props.class)}>
      <label class={styles['label']} for={id}>
        {props.label}
        {props.required === true ? (
          <span class={styles['required']} title={ui.t(UI_KEYS.required)}>
            *
          </span>
        ) : null}
        {props.markOptional === true ? (
          <span class={styles['optional']}>{ui.t(UI_KEYS.optional)}</span>
        ) : null}
      </label>
      {props.hint === undefined ? null : (
        <p class={styles['hint']} id={hintId}>
          {props.hint}
        </p>
      )}
      {props.children(control())}
      {props.error === undefined ? null : (
        <p class={styles['error']} id={errorId} role="alert">
          {props.error}
        </p>
      )}
    </div>
  );
}
