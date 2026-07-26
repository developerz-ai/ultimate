// Form shell. Owns the one thing every form needs and always forgets: a
// top-of-form error summary that is focusable and announced on submit.

import type { JSX } from 'solid-js';
import { useId } from '../a11y';
import { cx } from '../cx';
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
  const summaryId = useId('form-error');
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
        <div id={summaryId} tabindex="-1" class={styles['summary']}>
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
