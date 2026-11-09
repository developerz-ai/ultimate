// A bounded number: a native `<input type="range">` with its label and an `<output>` bound to it.
// The platform owns the thumb, the keyboard and the touch; the paint is tokens (`accent-color`).
// No thumb script — a kit without one sends an agent to a div. Rules: `slider-view.ts`.

import type { JSX } from 'solid-js';
import { useId } from '../a11y';
import { cx } from '../cx';
import { solid } from '../theme/solid-adapter';
import styles from './Slider.module.scss';
import { sliderNumbers } from './slider-view';

export interface SliderProps {
  name: string;
  /** Already-translated visible label. */
  label: string;
  id?: string | undefined;
  min?: number | undefined;
  max?: number | undefined;
  step?: number | undefined;
  value?: number | undefined;
  /** The output's text and the control's `aria-valuetext`, in the caller's locale and unit. */
  format?: ((value: number) => string) | undefined;
  disabled?: boolean | undefined;
  'aria-describedby'?: string | undefined;
  onInput?: ((value: number) => void) | undefined;
  class?: string | undefined;
}

export function Slider(props: SliderProps): JSX.Element {
  const rt = solid();
  const fallbackId = useId('slider');
  const id = (): string => props.id ?? fallbackId;
  const numbers = () =>
    sliderNumbers({ min: props.min, max: props.max, step: props.step, value: props.value });
  const [value, setValue] = rt.createSignal(numbers().value);
  const text = (): string => (props.format === undefined ? String(value()) : props.format(value()));

  return (
    <div class={cx(styles['slider'], props.class)}>
      <div class={styles['head']}>
        <label class={styles['label']} for={id()}>
          {props.label}
        </label>
        <output class={styles['output']} for={id()}>
          {text()}
        </output>
      </div>
      <input
        class={styles['input']}
        type="range"
        id={id()}
        name={props.name}
        min={numbers().min}
        max={numbers().max}
        step={numbers().step}
        value={numbers().value}
        disabled={props.disabled === true}
        aria-valuetext={props.format === undefined ? undefined : text()}
        aria-describedby={props['aria-describedby']}
        onInput={(event: InputEvent) => {
          const next = Number((event.currentTarget as HTMLInputElement).value);
          setValue(next);
          props.onInput?.(next);
        }}
      />
    </div>
  );
}
