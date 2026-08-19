// Form shell. Owns the one thing every form needs and always forgets: a top-of-form error summary
// that is announced (the Alert inside it is a live region) and that TAKES focus when an error
// arrives — the focus move is what makes the summary reachable at all, since its id is internal.

import type { JSX } from 'solid-js';
import { useId } from '../a11y';
import { cx } from '../cx';
import { solid } from '../theme/solid-adapter';
import { Alert } from './Alert';
import styles from './Form.module.scss';
import type { SpaceStep } from './variants';

export interface FormProps {
  children: JSX.Element;
  /** Already-translated summary shown above the fields when submit fails. */
  error?: string | undefined;
  /** Already-translated heading for the error summary region. */
  errorTitle?: string | undefined;
  actions?: JSX.Element | undefined;
  gap?: SpaceStep | undefined;
  method?: 'get' | 'post' | undefined;
  action?: string | undefined;
  novalidate?: boolean | undefined;
  class?: string | undefined;
  'aria-label'?: string | undefined;
  onSubmit?: JSX.EventHandlerUnion<HTMLFormElement, SubmitEvent> | undefined;
}

export function Form(props: FormProps): JSX.Element {
  const rt = solid();
  const summaryId = useId('form-error');
  let summary: HTMLDivElement | undefined;

  // `tabindex="-1"` alone was a focus target nothing ever aimed at: `summaryId` is internal, so no
  // caller could move focus here, and the component never did either. A failed submit that leaves
  // focus on the button leaves a keyboard user to hunt for what went wrong.
  rt.createEffect(() => {
    if (props.error !== undefined) summary?.focus();
  });

  return (
    <form
      class={cx(styles['form'], props.class)}
      style={{ '--form-gap': `var(--space-${props.gap ?? 5})` }}
      method={props.method ?? 'post'}
      action={props.action}
      novalidate={props.novalidate === true}
      aria-label={props['aria-label']}
      aria-describedby={props.error === undefined ? undefined : summaryId}
      onSubmit={props.onSubmit}
    >
      {props.error === undefined ? null : (
        <div
          ref={(el: HTMLDivElement) => {
            summary = el;
          }}
          id={summaryId}
          tabindex="-1"
          class={styles['summary']}
        >
          <Alert tone="danger" title={props.errorTitle}>
            {props.error}
          </Alert>
        </div>
      )}
      {props.children}
      {props.actions === undefined ? null : <div class={styles['actions']}>{props.actions}</div>}
    </form>
  );
}
