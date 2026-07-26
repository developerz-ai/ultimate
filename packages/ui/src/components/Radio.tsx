// Radio group. Rendered as a <fieldset>/<legend> so the group has a name, and as
// one native radio per option so arrow-key navigation is the platform's job.

import type { JSX } from 'solid-js';
import { useId } from '../a11y';
import { cx } from '../cx';
import styles from './Radio.module.scss';

export interface RadioOption {
  value: string;
  /** Already-translated. */
  label: string;
  description?: string | undefined;
  disabled?: boolean | undefined;
}

export interface RadioProps {
  /** Already-translated group label, rendered as the <legend>. */
  legend: string;
  name: string;
  options: readonly RadioOption[];
  value?: string | undefined;
  disabled?: boolean | undefined;
  required?: boolean | undefined;
  direction?: 'row' | 'column' | undefined;
  class?: string | undefined;
  'aria-describedby'?: string | undefined;
  onChange?: JSX.EventHandlerUnion<HTMLInputElement, Event> | undefined;
}

export function Radio(props: RadioProps): JSX.Element {
  const group = useId('radio');
  return (
    <fieldset
      class={cx(styles['group'], styles[`direction-${props.direction ?? 'column'}`], props.class)}
      disabled={props.disabled === true}
      aria-describedby={props['aria-describedby']}
    >
      <legend class={styles['legend']}>{props.legend}</legend>
      {props.options.map((option, index) => (
        <label class={styles['row']} for={`${group}-${index}`}>
          <input
            class={styles['input']}
            id={`${group}-${index}`}
            type="radio"
            name={props.name}
            value={option.value}
            checked={props.value === option.value}
            disabled={option.disabled === true}
            required={props.required === true}
            onChange={props.onChange}
          />
          <span aria-hidden="true" class={styles['dot']} />
          <span class={styles['text']}>
            <span class={styles['label']}>{option.label}</span>
            {option.description === undefined ? null : (
              <span class={styles['description']}>{option.description}</span>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
