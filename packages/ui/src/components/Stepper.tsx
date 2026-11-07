// Progress through a multi-step flow: an `<ol>`, the current step `aria-current="step"`, a passed
// step a link (its `href`) or a button (`onSelect`) and an upcoming one plain text. Exactly one
// current, by `stepperModel`. Below `sm` the list folds into one line, "Step {n} of {total}: Details".

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { linkTarget } from './link-target';
import styles from './Stepper.module.scss';
import { type StepperStep, stepperModel } from './stepper-view';

export interface StepperProps {
  steps: readonly StepperStep[];
  /** Already-translated name of the list — "Checkout progress". */
  label: string;
  /** A passed step with no `href` becomes a button that calls this. */
  onSelect?: ((id: string) => void) | undefined;
  class?: string | undefined;
}

export function Stepper(props: StepperProps): JSX.Element {
  const ui = useUi();
  const model = stepperModel(props.steps);
  const current = props.steps[model.current];

  const body = (step: StepperStep, index: number): JSX.Element => {
    const marker = <span class={styles['marker']}>{index + 1}</span>;
    const text = <span class={styles['label']}>{step.label}</span>;
    if (step.state === 'done' && step.href !== undefined) {
      return (
        <a class={styles['step']} href={linkTarget(step.href).href}>
          {marker}
          {text}
        </a>
      );
    }
    const onSelect = props.onSelect;
    if (step.state === 'done' && onSelect !== undefined) {
      return (
        <button type="button" class={styles['step']} onClick={() => onSelect(step.id)}>
          {marker}
          {text}
        </button>
      );
    }
    return (
      <span class={styles['step']} aria-current={step.state === 'current' ? 'step' : undefined}>
        {marker}
        {text}
      </span>
    );
  };

  return (
    <div class={cx(styles['stepper'], props.class)}>
      <p class={styles['compact']} aria-hidden="true">
        {ui.t(UI_KEYS.step, {
          current: model.current + 1,
          total: model.total,
          label: current?.label ?? '',
        })}
      </p>
      <ol class={styles['list']} aria-label={props.label}>
        {props.steps.map((step, index) => (
          <li class={styles['item']} data-state={step.state}>
            {body(step, index)}
          </li>
        ))}
      </ol>
    </div>
  );
}
