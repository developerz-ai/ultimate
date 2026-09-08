// Form shell. Owns the one thing every form needs and always forgets: a top-of-form error summary
// that is announced (the Alert inside it is a live region) and that TAKES focus when an error
// arrives — the focus move is what makes the summary reachable at all, since its id is internal.
//
// Focus goes to the first INVALID CONTROL when there is one, and to the summary only when there is
// not. GOV.UK's tested pattern is a summary whose entries LINK to their fields; that shape is not
// available here, because `Field` mints its control ids internally (`Field.tsx`) and inverting that
// ownership is the drift `Field` exists to prevent — a summary cannot write an `href` to an id it
// cannot see. Focusing the control directly reaches the same place in one step. The summary still
// announces, and is still where a form-level rejection (a policy refusal, an unmatched issue) puts
// the reader, because that one names no control to send them to.

import type { JSX } from 'solid-js';
import { ariaBool, useId } from '../a11y';
import { cx } from '../cx';
import { fieldSelector } from '../form/field-path';
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
  /**
   * The `name` of the control a failed submit should send the reader to — `form.firstInvalidField()`.
   * Focused in preference to the summary: the summary describes the problem, the control is where
   * it is fixed, and leaving the user on the summary strands them one Tab away from nothing.
   */
  invalidField?: string | undefined;
  /**
   * A submit is in flight — `form.pending()`. Suppresses the submit outright, so a double submit is
   * refused HERE and not only on whatever control happened to be clicked: Enter in a text field
   * submits a form with no button involved at all.
   */
  busy?: boolean | undefined;
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
  let element: HTMLFormElement | undefined;

  /**
   * The control the rejection named, inside THIS form. `fieldSelector` answers `null` for a name
   * the path grammar does not accept, which is the allowlist that keeps a caller's string out of a
   * selector — no accepted name can carry a quote or close the attribute.
   */
  const invalidControl = (): HTMLElement | null => {
    const name = props.invalidField;
    if (name === undefined || element === undefined) return null;
    const selector = fieldSelector(name);
    return selector === null ? null : element.querySelector<HTMLElement>(selector);
  };

  // `tabindex="-1"` alone was a focus target nothing ever aimed at: `summaryId` is internal, so no
  // caller could move focus here, and the component never did either. A failed submit that leaves
  // focus on the button leaves a keyboard user to hunt for what went wrong.
  rt.createEffect(() => {
    const control = invalidControl();
    if (control !== null) {
      control.focus();
      return;
    }
    if (props.error !== undefined) summary?.focus();
  });

  /**
   * A form already submitting cannot submit again. `aria-disabled` on the button is advisory and
   * Enter in a text field never touches the button at all, so this is the refusal that holds — and
   * it is a guard, not the guarantee: the binding joins an in-flight submit, and the server is the
   * only place a duplicate write is finally refused.
   */
  const onSubmit = (event: SubmitEvent): void => {
    if (props.busy === true) {
      event.preventDefault();
      return;
    }
    const handler = props.onSubmit;
    if (handler === undefined) return;
    if (typeof handler === 'function') handler(event as Parameters<typeof handler>[0]);
    else handler[0](handler[1], event as Parameters<(typeof handler)[0]>[1]);
  };

  return (
    <form
      ref={(el: HTMLFormElement) => {
        element = el;
      }}
      class={cx(styles['form'], props.class)}
      style={{ '--form-gap': `var(--space-${props.gap ?? 5})` }}
      method={props.method ?? 'post'}
      action={props.action}
      novalidate={props.novalidate === true}
      aria-label={props['aria-label']}
      aria-describedby={props.error === undefined ? undefined : summaryId}
      aria-busy={ariaBool(props.busy)}
      onSubmit={onSubmit}
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
